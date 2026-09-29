const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('src/Code.js', 'utf8');
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

function walkLeg(duration, startTime = 0) {
  return {
    leg_mode: 'walk',
    start_time: startTime,
    end_time: startTime + duration,
    duration,
  };
}

function planResult({ duration, endTime, legs }) {
  return {
    start_time: endTime - duration,
    end_time: endTime,
    duration,
    legs,
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

test('pickBestItinerary_ keeps a direct bus when a transfer is not more than 5 minutes faster', () => {
  const eventStart = new Date(10_000 * 1000);
  const direct = planResult({
    duration: 1800,
    endTime: 9300,
    legs: [
      walkLeg(120, 7500),
      transitLeg(),
      walkLeg(60, 9240),
    ],
  });
  const transfer = planResult({
    duration: 1600,
    endTime: 9400,
    legs: [
      walkLeg(120, 7800),
      transitLeg({ route_short_name: '18' }),
      transitLeg({ route_short_name: 'Loop' }),
      walkLeg(60, 9340),
    ],
  });

  assert.strictEqual(
    context.pickBestItinerary_({ results: [transfer, direct] }, eventStart),
    direct,
  );
});

test('pickBestItinerary_ allows a transfer when it cuts total trip time by more than 5 minutes', () => {
  const eventStart = new Date(10_000 * 1000);
  const direct = planResult({
    duration: 2400,
    endTime: 9300,
    legs: [
      walkLeg(120, 6900),
      transitLeg(),
      walkLeg(60, 9240),
    ],
  });
  const transfer = planResult({
    duration: 2000,
    endTime: 9400,
    legs: [
      walkLeg(120, 7400),
      transitLeg({ route_short_name: '18' }),
      transitLeg({ route_short_name: '19' }),
      walkLeg(60, 9340),
    ],
  });

  assert.strictEqual(
    context.pickBestItinerary_({ results: [direct, transfer] }, eventStart),
    transfer,
  );
});

test('pickBestItinerary_ only chooses walk-only fallback when walking is faster than transit', () => {
  const eventStart = new Date(10_000 * 1000);
  const transit = planResult({
    duration: 1000,
    endTime: 9300,
    legs: [
      walkLeg(120, 8300),
      transitLeg(),
      walkLeg(60, 9240),
    ],
  });
  const slowerWalk = planResult({
    duration: 1200,
    endTime: 9400,
    legs: [
      walkLeg(1200, 8200),
    ],
  });
  const fasterWalk = planResult({
    duration: 900,
    endTime: 9400,
    legs: [
      walkLeg(900, 8500),
    ],
  });

  assert.strictEqual(
    context.pickBestItinerary_({ results: [slowerWalk, transit] }, eventStart),
    transit,
  );
  assert.strictEqual(
    context.pickBestItinerary_({ results: [transit, fasterWalk] }, eventStart),
    fasterWalk,
  );
});

test('pickBestItinerary_ favors less walking among similarly fast bus trips', () => {
  const eventStart = new Date(10_000 * 1000);
  const longWalk = planResult({ duration: 1800, endTime: 9400, legs: [walkLeg(900, 7600), transitLeg()] });
  const shortWalk = planResult({ duration: 1900, endTime: 9300, legs: [walkLeg(180, 7400), transitLeg()] });
  assert.strictEqual(context.pickBestItinerary_({ results: [longWalk, shortWalk] }, eventStart), shortWalk);
});

test('transitPlanArriveBy_ requests minimized walking and directions at the configured pace', () => {
  let requestedUrl;
  context.UrlFetchApp = { fetch: url => {
    requestedUrl = url;
    return { getResponseCode: () => 200, getContentText: () => '{"results":[]}' };
  } };
  context.transitPlanArriveBy_('key', { lat: 1, lon: 2 }, { lat: 3, lon: 4 }, new Date(10_000 * 1000));
  const query = new URL(requestedUrl).searchParams;
  assert.strictEqual(query.get('walk_reluctance'), '2.1');
  assert.strictEqual(query.get('walk_speed'), '0.89');
  assert.strictEqual(query.get('should_include_directions'), 'true');
});

test('getWalkingLines_ names the boarding stop and destination with API walk times', () => {
  const itinerary = { legs: [
    { ...walkLeg(330), directions: [{ instruction: 'Head toward Bay Street' }] },
    transitLeg(),
    walkLeg(120),
  ] };
  const description = context.getWalkingLines_(itinerary, { summary: 'Class', location: 'Science Hill, Santa Cruz' }, [['Bay and High', 'Campus']]);
  assert.ok(description.includes('Walk to Bay and High: about 6 min'));
  assert.ok(description.includes('Head toward Bay Street'));
  assert.ok(description.includes('Walk to Science Hill, Santa Cruz: about 2 min'));
});

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
  assert.strictEqual(context.cleanCommuteSummaryCountdown_('🚍 18 go in 5 minutes to: Class'), '🚍 18 to: Class');
});

test('findCommuteEvents_ matches the exact parent ID across pages without text search', () => {
  const parent = { id: 'class-1', start: { dateTime: new Date(2026, 0, 1, 13).toISOString() } };
  const calls = [];
  context.Calendar = { Events: { list: (_calId, params) => {
    calls.push(params);
    return params.pageToken ? { items: [{ id: 'match', start: { dateTime: new Date(2026, 0, 1, 12).toISOString() }, description: 'auto_commute_parent=class-1' }] }
      : { nextPageToken: 'next', items: [{ id: 'wrong', start: { dateTime: new Date(2026, 0, 1, 12).toISOString() }, description: 'auto_commute_parent=class-10' }] };
  } } };
  const events = context.findCommuteEvents_('AutoTransit', parent);
  assert.strictEqual(JSON.stringify(events.map(event => event.id)), JSON.stringify(['match']));
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].q, undefined);
});

test('shouldProcess_ ignores nearby commute events belonging to a different source event', () => {
  const now = new Date(2026, 0, 1, 8);
  const parent = { id: 'class-1', start: { dateTime: new Date(2026, 0, 1, 10).toISOString() } };
  context.Calendar = { Events: { list: () => ({ items: [{
    id: 'other-commute',
    start: { dateTime: new Date(2026, 0, 1, 9).toISOString() },
    description: 'auto_commute_parent=class-2',
  }] }) } };
  assert.strictEqual(context.shouldProcess_([parent], 'AutoTransit', now, parent), true);
});

test('formatEventChangeLogLine_ describes event writes with route, destination, and date', () => {
  const date = new Date(2026, 0, 2, 8, 30);

  assert.strictEqual(
    context.formatEventChangeLogLine_('made', '18', 'CSE 101', date),
    'Made 18 to CSE 101 on Jan 2, 2026',
  );
  assert.strictEqual(
    context.formatEventChangeLogLine_('updated', 'Bus', '(untitled)', date),
    'Updated Bus to (untitled) on Jan 2, 2026',
  );
  assert.strictEqual(
    context.formatEventChangeLogLine_('deleted', null, null, date),
    'Deleted Bus to (untitled) on Jan 2, 2026',
  );
});

test('recordEventChange_ logs each change and increments the tracker', () => {
  const lines = [];
  const tracker = createChangeTracker_(lines);

  context.recordEventChange_(tracker, {
    action: 'made',
    busNumber: '19',
    destination: 'Science Hill',
    date: new Date(2026, 0, 3, 9, 15),
  });
  context.recordEventChange_(tracker, {
    action: 'deleted',
    busNumber: '20',
    destination: 'Old commute',
    date: new Date(2026, 0, 4, 10, 45),
  });

  assert.strictEqual(tracker.count, 2);
  assert.strictEqual(JSON.stringify(lines), JSON.stringify([
    'Made 19 to Science Hill on Jan 3, 2026',
    'Deleted 20 to Old commute on Jan 4, 2026',
  ]));
});

test('createPlannerEventWindow_ returns the source calendar scrape window around now', () => {
  const now = new Date(2026, 0, 1, 8, 0);
  const window = context.createPlannerEventWindow_(now);

  assert.strictEqual(window.timeMin.toISOString(), new Date(2026, 0, 1, 6, 30).toISOString());
  assert.strictEqual(window.timeMax.toISOString(), new Date(2026, 0, 2, 8, 0).toISOString());
});

test('createCommuteSearchWindow_ uses the same buffer before and after commute times', () => {
  const start = new Date(2026, 0, 1, 7, 30);
  const end = new Date(2026, 0, 1, 8, 45);
  const window = context.createCommuteSearchWindow_(start, end);

  assert.strictEqual(window.timeMin.toISOString(), new Date(2026, 0, 1, 1, 30).toISOString());
  assert.strictEqual(window.timeMax.toISOString(), new Date(2026, 0, 1, 14, 45).toISOString());
});

test('shouldShowDepartureCountdown_ only shows upcoming departures within countdown window', () => {
  const now = new Date(2026, 0, 1, 8, 0);

  assert.strictEqual(context.shouldShowDepartureCountdown_(new Date(2026, 0, 1, 8, 14), now), true);
  assert.strictEqual(context.shouldShowDepartureCountdown_(new Date(2026, 0, 1, 8, 15), now), false);
  assert.strictEqual(context.shouldShowDepartureCountdown_(new Date(2026, 0, 1, 7, 59), now), false);
});

test('shouldRefreshExistingCommute_ refreshes near departures with a five minute grace period', () => {
  const now = new Date(2026, 0, 1, 8, 0);

  assert.strictEqual(context.shouldRefreshExistingCommute_(new Date(2026, 0, 1, 8, 25), now), true);
  assert.strictEqual(context.shouldRefreshExistingCommute_(new Date(2026, 0, 1, 8, 26), now), false);
  assert.strictEqual(context.shouldRefreshExistingCommute_(new Date(2026, 0, 1, 7, 56), now), true);
  assert.strictEqual(context.shouldRefreshExistingCommute_(new Date(2026, 0, 1, 7, 54), now), false);
});

test('minutesToMilliseconds_ converts minute units consistently', () => {
  assert.strictEqual(context.minutesToMilliseconds_(90), 5_400_000);
});

function createChangeTracker_(lines) {
  return {
    count: 0,
    log: (line) => lines.push(line),
  };
}

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

test('upsertCommuteEvent_ updates an existing parent commute instead of inserting', () => {
  const start = Math.floor(new Date(2026, 0, 1, 8).getTime() / 1000);
  const leg = transitLeg();
  leg.start_time = start + 300;
  leg.end_time = start + 1200;
  const itinerary = { start_time: start, end_time: start + 1500, legs: [
    walkLeg(300, start), leg, walkLeg(300, start + 1200),
  ] };
  const parent = { id: 'class-1', summary: 'Class', location: 'Science Hill, Santa Cruz', start: { dateTime: new Date((start + 3600) * 1000).toISOString() } };
  const patched = [];
  const inserted = [];
  context.Calendar = { Events: {
    list: () => ({ items: [{ id: 'commute-1', start: { dateTime: new Date(start * 1000).toISOString() }, description: 'auto_commute_parent=class-1' }] }),
    patch: (body, _calId, id) => patched.push({ body, id }),
    insert: body => inserted.push(body),
  } };
  context.upsertCommuteEvent_('AutoTransit', parent, itinerary, new Date((start - 1800) * 1000), {}, createChangeTracker_([]));
  assert.strictEqual(patched.length, 1);
  assert.strictEqual(patched[0].id, 'commute-1');
  assert.strictEqual(inserted.length, 0);
  assert.ok(patched[0].body.description.includes('Go at'));
  assert.ok(patched[0].body.description.includes('Bus leaves at'));
  assert.ok(patched[0].body.description.includes('Walk to Bay and High'));
});

test('cleanupPastDuplicateCommuteEventsBatch_ keeps latest duplicate and valid split legs', () => {
  const day = new Date(2026, 0, 1, 8).getTime();
  const event = (id, parent, startOffset, endOffset, createdOffset, stop) => ({
    id,
    created: new Date(day + createdOffset).toISOString(),
    start: { dateTime: new Date(day + startOffset).toISOString() },
    end: { dateTime: new Date(day + endOffset).toISOString() },
    description: `Get on at: ${stop} @ 8:00 AM\nauto_commute_parent=${parent}`,
  });
  const events = [
    event('old', 'one', 0, 1800000, 0, 'Bay'),
    event('new', 'one', 60000, 1860000, 1000, 'Bay'),
    event('split-first', 'two', 0, 600000, 0, 'Bay'),
    event('split-second', 'two', 1200000, 1800000, 1000, 'Campus'),
  ];
  const removed = [];
  context.Calendar = { Events: {
    list: () => ({ items: events }),
    remove: (_calId, id) => removed.push(id),
  } };
  const deleted = context.cleanupPastDuplicateCommuteEventsBatch_('AutoTransit', { now: new Date(day + 7200000) });
  assert.strictEqual(deleted, 1);
  assert.strictEqual(JSON.stringify(removed), JSON.stringify(['old']));
});
