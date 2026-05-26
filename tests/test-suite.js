const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('AppsScript.gs', 'utf8');
const context = {
  console,
  Intl,
  Date,
};
vm.createContext(context);
vm.runInContext(source, context);

function transitLeg(routeOverrides = {}) {
  const firstDeparture = Math.floor(new Date(2026, 0, 1, 12, 0).getTime() / 1000);
  const secondDeparture = Math.floor(new Date(2026, 0, 1, 12, 21).getTime() / 1000);
  return {
    leg_mode: 'transit',
    start_time: 1000,
    end_time: 1600,
    departures: [
      { departure_time: firstDeparture },
      { departure_time: secondDeparture },
    ],
    routes: [
      {
        route_short_name: '18',
        route_type: 3,
        global_route_id: 'SCMTD:18',
        itineraries: [
          {
            direction_id: 1,
            plan_details: {
              start_stop_offset: 0,
              end_stop_offset: 1,
            },
            stops: [
              { stop_name: 'Bay and High' },
              { stop_name: 'Science Hill' },
            ],
          },
        ],
        vehicle: { name: 'bus' },
        ...routeOverrides,
      },
    ],
  };
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test('extractVehicleRequestsForItinerary_ returns only bus transit legs with route and optional direction', () => {
  const itinerary = {
    legs: [
      { leg_mode: 'walk' },
      transitLeg(),
      transitLeg({
        route_short_name: 'Metro',
        route_type: 1,
        global_route_id: 'SCMTD:metro',
        vehicle: { name: 'métro' },
      }),
      transitLeg({ route_short_name: '20', global_route_id: null }),
    ],
  };

  assert.strictEqual(JSON.stringify(context.extractVehicleRequestsForItinerary_(itinerary)), JSON.stringify([
    { legIndex: 0, globalRouteId: 'SCMTD:18', directionId: 1 },
  ]));
});

test('buildCrowdingLine_ describes occupancy status and includes next departure for crowded buses', () => {
  const leg = transitLeg();
  const notCrowded = context.buildCrowdingLine_(leg, 1);
  const crowded = context.buildCrowdingLine_(leg, 3);
  const crowdedPrefix = 'Crowding: crowded. If skipped, next departure is at ';

  assert.strictEqual(notCrowded, 'Crowding: not crowded');
  assert.ok(crowded.startsWith(crowdedPrefix));
  assert.ok(crowded.length > crowdedPrefix.length);
});

test('buildCrowdingLine_ omits unknown occupancy statuses', () => {
  assert.strictEqual(context.buildCrowdingLine_(transitLeg(), null), '');
  assert.strictEqual(context.buildCrowdingLine_(transitLeg(), 99), '');
});

test('cleanCommuteSummaryCountdown_ removes this minute and in n minute countdowns', () => {
  assert.strictEqual(
    context.cleanCommuteSummaryCountdown_(':oncoming_bus: 18 in 1 minute to: CSE 101'),
    ':oncoming_bus: 18 to: CSE 101',
  );
  assert.strictEqual(
    context.cleanCommuteSummaryCountdown_(':oncoming_bus: 18 this minute to: ECE 10'),
    ':oncoming_bus: 18 to: ECE 10',
  );
  assert.strictEqual(
    context.cleanCommuteSummaryCountdown_('🚍 18 in 12 minutes to: CSE 101'),
    '🚍 18 to: CSE 101',
  );
  assert.strictEqual(
    context.cleanCommuteSummaryCountdown_('🚍 18 to: CSE 101'),
    '🚍 18 to: CSE 101',
  );
  assert.strictEqual(
    context.cleanCommuteSummaryCountdown_('Foo Bar in 1 minute to: leave'),
    'Foo Bar in 1 minute to: leave',
  );
});

test('cleanupPastCommuteEventTitlesBatch_ only patches completed countdown events', () => {
  const now = new Date(2026, 0, 1, 13, 0);
  const patched = [];
  const events = [
    {
      id: 'past-this-minute',
      summary: ':oncoming_bus: 18 this minute to: ECE 10',
      end: { dateTime: new Date(2026, 0, 1, 12, 30).toISOString() },
    },
    {
      id: 'past-in-minute',
      summary: ':oncoming_bus: 18 in 1 minute to: CSE 101',
      end: { dateTime: new Date(2026, 0, 1, 12, 45).toISOString() },
    },
    {
      id: 'future',
      summary: ':oncoming_bus: 18 this minute to: Future',
      end: { dateTime: new Date(2026, 0, 1, 13, 30).toISOString() },
    },
    {
      id: 'clean',
      summary: ':oncoming_bus: 18 to: Clean',
      end: { dateTime: new Date(2026, 0, 1, 12, 0).toISOString() },
    },
  ];

  context.Calendar = {
    Events: {
      list: () => ({ items: events }),
      patch: (body, calId, id) => patched.push({ body, calId, id }),
    },
  };
  context.Utilities = { sleep: () => {} };

  const result = context.cleanupPastCommuteEventTitlesBatch_('AutoTransit', {
    now,
    sleepMs: 0,
    maxUpdates: 50,
  });

  assert.strictEqual(result.updated, 2);
  assert.strictEqual(JSON.stringify(patched), JSON.stringify([
    {
      body: { summary: ':oncoming_bus: 18 to: ECE 10' },
      calId: 'AutoTransit',
      id: 'past-this-minute',
    },
    {
      body: { summary: ':oncoming_bus: 18 to: CSE 101' },
      calId: 'AutoTransit',
      id: 'past-in-minute',
    },
  ]));
});

test('cleanupPastCommuteEventTitles stores next page token for follow-up runs', () => {
  const props = {
    TARGET_CALENDAR_ID: 'AutoTransit',
    CLEANUP_PAST_COMMUTE_TITLES_PAGE_TOKEN_DO_NOT_MANUALLY_MODIFY: 'old-token',
  };
  const calls = [];

  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (name) => props[name] || null,
      setProperty: (name, value) => {
        props[name] = value;
      },
      deleteProperty: (name) => {
        delete props[name];
      },
    }),
  };
  context.Calendar = {
    Events: {
      list: (calId, params) => {
        calls.push({ calId, pageToken: params.pageToken });
        return {
          nextPageToken: 'new-token',
          items: [],
        };
      },
      patch: () => {
        throw new Error('no patches expected');
      },
    },
  };

  context.cleanupPastCommuteEventTitles();

  assert.strictEqual(props.CLEANUP_PAST_COMMUTE_TITLES_PAGE_TOKEN_DO_NOT_MANUALLY_MODIFY, 'new-token');
  assert.strictEqual(JSON.stringify(calls), JSON.stringify([
    { calId: 'AutoTransit', pageToken: 'old-token' },
  ]));
});
