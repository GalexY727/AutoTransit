# Multi-Leg Transit Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend AutoTransit to show multi-leg itineraries in Google Calendar — combined event for short transfers, two split events for transfers ≥ 15 min.

**Architecture:** All changes are in `AppsScript.gs`. Data-extraction functions (`getRelevantBusTimes_`, `getRelevantBusStops_`, `getBusNumber_`) are updated to return per-leg arrays. `upsertCommuteEvent_` gains a dispatch block routing to single-leg (unchanged output), combined multi-leg, or split-event paths based on leg count and transfer wait time. The sort-match update mechanism reuses the existing `auto_commute_parent=<id>` marker with no format change.

**Tech Stack:** Google Apps Script (ES6+), Google Calendar API via Apps Script's `Calendar.Events`

> **Testing note:** This project has no automated test runner. Each task includes a `test_*` function to paste temporarily into `AppsScript.gs`. Run it via the Apps Script IDE (select the function, click ▶ Run, check the Execution log). Remove all test functions before the final commit in Task 8.

---

### Task 1: Add `getTransitLegs_` helper

**Files:**
- Modify: `AppsScript.gs` — add `getTransitLegs_` after `getBusNumber_`

- [ ] **Step 1: Add the test function** — paste into `AppsScript.gs`

```javascript
function test_getTransitLegs_() {
  const mock = { legs: [
    { leg_mode: 'walk' },
    { leg_mode: 'transit', routes: [{ route_short_name: '19' }] },
    { leg_mode: 'walk' },
    { leg_mode: 'transit', routes: [{ route_short_name: '16' }] },
  ]};
  const result = getTransitLegs_(mock);
  console.assert(result.length === 2, 'FAIL: expected 2 transit legs, got ' + result.length);
  console.assert(result[0].routes[0].route_short_name === '19', 'FAIL: first leg should be route 19');
  console.assert(getTransitLegs_(null).length === 0, 'FAIL: null input should return []');
  console.assert(getTransitLegs_({}).length === 0, 'FAIL: missing legs should return []');
  console.log('[PASS] test_getTransitLegs_');
}
```

- [ ] **Step 2: Run the test — confirm it fails** (function does not exist yet)

```
Apps Script IDE → select test_getTransitLegs_ → Run ▶
Expected in Execution log: ReferenceError: getTransitLegs_ is not defined
```

- [ ] **Step 3: Add `getTransitLegs_`** — insert after the closing brace of `getBusNumber_`

```javascript
function getTransitLegs_(itinerary) {
    return (itinerary?.legs || []).filter(l => l.leg_mode === 'transit');
}
```

- [ ] **Step 4: Run the test — confirm it passes**

```
Apps Script IDE → select test_getTransitLegs_ → Run ▶
Expected in Execution log: [PASS] test_getTransitLegs_
```

- [ ] **Step 5: Commit**

```bash
git add AppsScript.gs
git commit -m "Add getTransitLegs_ helper for multi-leg support"
```

---

### Task 2: Update `getRelevantBusTimes_` to return array-of-pairs + fix callers

**Files:**
- Modify: `AppsScript.gs` — `getRelevantBusTimes_` and its two call sites in `upsertCommuteEvent_`

- [ ] **Step 1: Add the test function**

```javascript
function test_getRelevantBusTimes_() {
  const mock = { legs: [
    { leg_mode: 'walk', start_time: 500, end_time: 900 },
    { leg_mode: 'transit', start_time: 1000, end_time: 2000 },
    { leg_mode: 'walk',    start_time: 2000, end_time: 2100 },
    { leg_mode: 'transit', start_time: 3000, end_time: 4000 },
  ]};
  const result = getRelevantBusTimes_(mock);
  console.assert(Array.isArray(result), 'FAIL: result should be an array');
  console.assert(result.length === 2, 'FAIL: expected 2 pairs, got ' + result.length);
  console.assert(Array.isArray(result[0]), 'FAIL: result[0] should be an array pair');
  console.assert(result[0][0].getTime() === 1000 * 1000, 'FAIL: leg1 departure');
  console.assert(result[0][1].getTime() === 2000 * 1000, 'FAIL: leg1 arrival');
  console.assert(result[1][0].getTime() === 3000 * 1000, 'FAIL: leg2 departure');
  console.assert(result[1][1].getTime() === 4000 * 1000, 'FAIL: leg2 arrival');
  console.log('[PASS] test_getRelevantBusTimes_');
}
```

- [ ] **Step 2: Run — confirm it fails** (old function returns flat `[Date, Date]`, not nested)

```
Apps Script IDE → select test_getRelevantBusTimes_ → Run ▶
Expected: Assertion failed (result[0] is a Date, not an Array)
```

- [ ] **Step 3: Replace `getRelevantBusTimes_` with the new version**

```javascript
function getRelevantBusTimes_(itinerary) {
    // Returns [[depart, arrive], ...] — one pair per transit leg in order
    return getTransitLegs_(itinerary).map(leg => [
        new Date(leg.start_time * 1000),
        new Date(leg.end_time * 1000),
    ]);
}
```

- [ ] **Step 4: Fix the three call sites in `upsertCommuteEvent_`**

The old code used `relevantBusTimes[0]` (board time) and `relevantBusTimes[1]` (alight time) as flat Dates. They must become `relevantBusTimes[0][0]` and `relevantBusTimes[0][1]`.

Find and replace these three lines in `upsertCommuteEvent_` (leave everything else unchanged):

| Old | New |
|---|---|
| `` `Bus left at ${ toRelativeTime_(relevantBusTimes[0]) }` `` | `` `Bus left at ${ toRelativeTime_(relevantBusTimes[0][0]) }` `` |
| `` `Bus leaves ${ relativeLeaveTime } at ${ toRelativeTime_(relevantBusTimes[0]) }` `` | `` `Bus leaves ${ relativeLeaveTime } at ${ toRelativeTime_(relevantBusTimes[0][0]) }` `` |
| `` `... + " @ " + toRelativeTime_(relevantBusTimes[0]) }` `` (Get on at line) | `` `... + " @ " + toRelativeTime_(relevantBusTimes[0][0]) }` `` |
| `` `... + " @ " + toRelativeTime_(relevantBusTimes[1])}` `` (Get off at line) | `` `... + " @ " + toRelativeTime_(relevantBusTimes[0][1])}` `` |

After the edit the relevant section of `upsertCommuteEvent_` reads:

```javascript
    const busStatusLine = busAlreadyLeft
        ? `Bus left at ${ toRelativeTime_(relevantBusTimes[0][0]) }` +
          (nextDeparture ? `. Next departure is at ${ toRelativeTime_(nextDeparture) }` : "")
        : `Bus leaves ${ relativeLeaveTime } at ${ toRelativeTime_(relevantBusTimes[0][0]) }`;

    const body = {
        summary,
        description: dedent_
                `
                ${ busStatusLine }
                 ➟ Last updated at ${ toRelativeTime_(now) }

                Get on at:   ${ (relevantBusStops[0] || parentEv.summary || "unknown stop | stay vigilant!") + " @ " + toRelativeTime_(relevantBusTimes[0][0]) }
                Get off at:   ${ (relevantBusStops[1] || parentEv.summary || "unknown stop | stay vigilant!") + " @ " + toRelativeTime_(relevantBusTimes[0][1])}
```

> `relevantBusStops` is still the old flat format until Task 3 — that's intentional and safe.

- [ ] **Step 5: Run the test — confirm it passes**

```
Apps Script IDE → select test_getRelevantBusTimes_ → Run ▶
Expected: [PASS] test_getRelevantBusTimes_
```

- [ ] **Step 6: Commit**

```bash
git add AppsScript.gs
git commit -m "Update getRelevantBusTimes_ to return per-leg array of pairs"
```

---

### Task 3: Update `getRelevantBusStops_` to return array-of-pairs + fix callers

**Files:**
- Modify: `AppsScript.gs` — `getRelevantBusStops_` and its two call sites in `upsertCommuteEvent_`

- [ ] **Step 1: Add the test function**

```javascript
function test_getRelevantBusStops_() {
  const makeLeg = (on, off) => ({ leg_mode: 'transit', routes: [{ itineraries: [{
    plan_details: { start_stop_offset: 0, end_stop_offset: 1 },
    stops: [{ stop_name: on }, { stop_name: off }],
  }]}]});
  const mock = { legs: [ makeLeg('Stop A', 'Stop B'), makeLeg('Stop C', 'Stop D') ]};
  const result = getRelevantBusStops_(mock);
  console.assert(result.length === 2, 'FAIL: expected 2 pairs, got ' + result.length);
  console.assert(Array.isArray(result[0]), 'FAIL: result[0] should be an array');
  console.assert(result[0][0] === 'Stop A', 'FAIL: leg1 on stop');
  console.assert(result[0][1] === 'Stop B', 'FAIL: leg1 off stop');
  console.assert(result[1][0] === 'Stop C', 'FAIL: leg2 on stop');
  console.assert(result[1][1] === 'Stop D', 'FAIL: leg2 off stop');
  // Leg with missing plan_details returns [null, null]
  const bad = { legs: [{ leg_mode: 'transit', routes: [{ itineraries: [{}] }] }] };
  console.assert(getRelevantBusStops_(bad)[0][0] === null, 'FAIL: missing pd should give null');
  console.log('[PASS] test_getRelevantBusStops_');
}
```

- [ ] **Step 2: Run — confirm it fails** (old function returns flat `[string, string]`)

```
Apps Script IDE → select test_getRelevantBusStops_ → Run ▶
Expected: Assertion failed (result[0] is a string, not an Array)
```

- [ ] **Step 3: Replace `getRelevantBusStops_` with the new version**

```javascript
function getRelevantBusStops_(itinerary) {
    // Returns [[onStop, offStop], ...] — one pair per transit leg in order.
    // Either element can be null if stop data is unavailable.
    return getTransitLegs_(itinerary).map(leg => {
        const itin = leg?.routes?.[0]?.itineraries?.[0];
        const pd = itin?.plan_details;
        if (!pd) return [null, null];
        return [
            itin.stops?.[pd.start_stop_offset]?.stop_name || null,
            itin.stops?.[pd.end_stop_offset]?.stop_name   || null,
        ];
    });
}
```

- [ ] **Step 4: Fix the two call sites in `upsertCommuteEvent_`**

| Old | New |
|---|---|
| `relevantBusStops[0] \|\|` (Get on at line) | `relevantBusStops[0][0] \|\|` |
| `relevantBusStops[1] \|\|` (Get off at line) | `relevantBusStops[0][1] \|\|` |

After the edit the description block reads:

```javascript
                Get on at:   ${ (relevantBusStops[0][0] || parentEv.summary || "unknown stop | stay vigilant!") + " @ " + toRelativeTime_(relevantBusTimes[0][0]) }
                Get off at:   ${ (relevantBusStops[0][1] || parentEv.summary || "unknown stop | stay vigilant!") + " @ " + toRelativeTime_(relevantBusTimes[0][1])}
```

- [ ] **Step 5: Add null-guard at the top of `upsertCommuteEvent_`**, immediately after the four `const` declarations for `busNumber`, `relevantBusTimes`, `relevantBusStops`, `transitLegs`:

```javascript
    if (!relevantBusTimes.length) return; // no transit legs found; nothing to upsert
```

- [ ] **Step 6: Run the test — confirm it passes**

```
Apps Script IDE → select test_getRelevantBusStops_ → Run ▶
Expected: [PASS] test_getRelevantBusStops_
```

- [ ] **Step 7: Commit**

```bash
git add AppsScript.gs
git commit -m "Update getRelevantBusStops_ to return per-leg array of pairs"
```

---

### Task 4: Update `getBusNumber_` to join all route names

**Files:**
- Modify: `AppsScript.gs` — `getBusNumber_` only; no caller changes needed (still returns a string)

- [ ] **Step 1: Add the test function**

```javascript
function test_getBusNumber_() {
  const single = { legs: [
    { leg_mode: 'walk' },
    { leg_mode: 'transit', routes: [{ route_short_name: '19' }] },
  ]};
  const multi = { legs: [
    { leg_mode: 'walk' },
    { leg_mode: 'transit', routes: [{ route_short_name: '19' }] },
    { leg_mode: 'walk' },
    { leg_mode: 'transit', routes: [{ route_short_name: '16' }] },
  ]};
  const noRoute = { legs: [{ leg_mode: 'transit', routes: [{}] }] };
  console.assert(getBusNumber_(single) === '19',      'FAIL: single-leg should return "19"');
  console.assert(getBusNumber_(multi)  === '19 → 16', 'FAIL: multi-leg should return "19 → 16"');
  console.assert(getBusNumber_(noRoute) === null,     'FAIL: missing route_short_name should return null');
  console.log('[PASS] test_getBusNumber_');
}
```

- [ ] **Step 2: Run — confirm it fails** (old function returns only first route; `'19 → 16'` assertion fails)

```
Apps Script IDE → select test_getBusNumber_ → Run ▶
Expected: Assertion failed: FAIL: multi-leg should return "19 → 16"
```

- [ ] **Step 3: Replace `getBusNumber_`**

```javascript
function getBusNumber_(itinerary) {
    // For multi-leg trips, joins all route short names with " → " (e.g. "19 → 16").
    // Single-leg output is unchanged.
    const busNums = getTransitLegs_(itinerary)
        .map(leg => leg?.routes?.[0]?.route_short_name)
        .filter(Boolean);
    return busNums.length ? busNums.join(' → ') : null;
}
```

- [ ] **Step 4: Run the test — confirm it passes**

```
Apps Script IDE → select test_getBusNumber_ → Run ▶
Expected: [PASS] test_getBusNumber_
```

- [ ] **Step 5: Commit**

```bash
git add AppsScript.gs
git commit -m "Update getBusNumber_ to join all transit leg route names"
```

---

### Task 5: Add `getTransferWaits_`

**Files:**
- Modify: `AppsScript.gs` — add `getTransferWaits_` after `getTransitLegs_`

- [ ] **Step 1: Add the test function**

```javascript
function test_getTransferWaits_() {
  const legs = [
    { start_time: 1000, end_time: 2000 },
    { start_time: 2360, end_time: 3000 },  // wait = 360s
    { start_time: 3900, end_time: 4000 },  // wait = 900s
  ];
  const waits = getTransferWaits_(legs);
  console.assert(waits.length === 2,   'FAIL: expected 2 waits for 3 legs');
  console.assert(waits[0] === 360,     'FAIL: first wait should be 360s');
  console.assert(waits[1] === 900,     'FAIL: second wait should be 900s');
  // Negative gap (realtime anomaly) is clamped to 0
  const overlap = [{ start_time: 100, end_time: 200 }, { start_time: 180, end_time: 300 }];
  console.assert(getTransferWaits_(overlap)[0] === 0, 'FAIL: negative gap should clamp to 0');
  // Single leg → no waits
  console.assert(getTransferWaits_([{ start_time: 1, end_time: 2 }]).length === 0, 'FAIL: single leg should have 0 waits');
  console.log('[PASS] test_getTransferWaits_');
}
```

- [ ] **Step 2: Run — confirm it fails**

```
Apps Script IDE → select test_getTransferWaits_ → Run ▶
Expected: ReferenceError: getTransferWaits_ is not defined
```

- [ ] **Step 3: Add `getTransferWaits_`** — insert after `getTransitLegs_`

```javascript
function getTransferWaits_(transitLegs) {
    // Returns an array of wait times in seconds between consecutive transit legs.
    // Clamped to 0 to handle real-time anomalies where leg N+1 departs before leg N arrives.
    const waits = [];
    for (let i = 0; i < transitLegs.length - 1; i++) {
        waits.push(Math.max(0, transitLegs[i + 1].start_time - transitLegs[i].end_time));
    }
    return waits;
}
```

- [ ] **Step 4: Run the test — confirm it passes**

```
Apps Script IDE → select test_getTransferWaits_ → Run ▶
Expected: [PASS] test_getTransferWaits_
```

- [ ] **Step 5: Commit**

```bash
git add AppsScript.gs
git commit -m "Add getTransferWaits_ for transfer detection"
```

---

### Task 6: Extend `getNextDeparture_` for leg index + add `buildLegDescriptionBlocks_`

**Files:**
- Modify: `AppsScript.gs` — update `getNextDeparture_`, add `buildLegDescriptionBlocks_`

The spec listed `getNextDeparture_` as unchanged, but split events need to query next departure per-leg (split event 2 should show the next bus for leg 2, not leg 1). Adding an optional `legIndex` parameter is a backward-compatible extension — existing callers with no second argument still get leg 0 behaviour.

- [ ] **Step 1: Add the test function**

```javascript
function test_getNextDeparture_() {
  const mock = { legs: [
    { leg_mode: 'walk' },
    { leg_mode: 'transit', departures: [{ departure_time: 1000 }, { departure_time: 2000 }] },
    { leg_mode: 'transit', departures: [{ departure_time: 3000 }, { departure_time: 4000 }] },
  ]};
  const leg0 = getNextDeparture_(mock, 0);
  console.assert(leg0?.getTime() === 2000 * 1000, 'FAIL: leg0 next departure');
  const leg1 = getNextDeparture_(mock, 1);
  console.assert(leg1?.getTime() === 4000 * 1000, 'FAIL: leg1 next departure');
  // Default (no index) must still return leg 0's next departure
  const def = getNextDeparture_(mock);
  console.assert(def?.getTime() === 2000 * 1000, 'FAIL: default should use leg 0');
  // Leg with only 1 departure → null
  const one = { legs: [{ leg_mode: 'transit', departures: [{ departure_time: 999 }] }] };
  console.assert(getNextDeparture_(one) === null, 'FAIL: single departure should return null');
  console.log('[PASS] test_getNextDeparture_');
}
```

- [ ] **Step 2: Run — confirm it fails** (`legIndex` param doesn't exist; leg1 assertion fails)

```
Apps Script IDE → select test_getNextDeparture_ → Run ▶
Expected: Assertion failed: FAIL: leg1 next departure
```

- [ ] **Step 3: Replace `getNextDeparture_`**

```javascript
function getNextDeparture_(itinerary, legIndex) {
    // Returns the departure time of the *next* bus after the planned one for a given leg.
    // legIndex defaults to 0 (first transit leg) for backward compatibility.
    // Requires max_num_departures >= 2 in the API request (v4 departures array).
    const legs = getTransitLegs_(itinerary);
    const leg = legs[legIndex ?? 0];
    if (!leg) return null;
    const departures = leg?.departures || [];
    // departures[0] is the planned trip; departures[1] is the following service
    if (departures.length < 2) return null;
    return new Date(departures[1].departure_time * 1000);
}
```

- [ ] **Step 4: Add the test for `buildLegDescriptionBlocks_`**

```javascript
function test_buildLegDescriptionBlocks_() {
  const t = (s) => new Date(s * 1000);
  const busTimes = [[t(1746041880), t(1746042600)], [t(1746043080), t(1746043320)]];
  const busStops = [['Western Dr / Western Ct', 'UCSC - Lower Campus'],
                    ['UCSC - Lower Campus', 'Bay / High']];
  const legs = [
    { leg_mode: 'transit', start_time: 1746041880, end_time: 1746042600,
      routes: [{ route_short_name: '19' }] },
    { leg_mode: 'transit', start_time: 1746043080, end_time: 1746043320,
      routes: [{ route_short_name: '16' }] },
  ];
  const result = buildLegDescriptionBlocks_(busTimes, busStops, legs);
  // transfer = 1746043080 - 1746042600 = 480s = 8 min
  console.assert(result.includes('Leg 1 — Route 19'),   'FAIL: Leg 1 header');
  console.assert(result.includes('Get on at:'),          'FAIL: Get on at line');
  console.assert(result.includes('Get off at:'),         'FAIL: Get off at line');
  console.assert(result.includes('Transfer: 8 min wait'),'FAIL: transfer line (should be 8 min)');
  console.assert(result.includes('Leg 2 — Route 16'),   'FAIL: Leg 2 header');
  console.log('[PASS] test_buildLegDescriptionBlocks_');
}
```

- [ ] **Step 5: Run — confirm it fails**

```
Apps Script IDE → select test_buildLegDescriptionBlocks_ → Run ▶
Expected: ReferenceError: buildLegDescriptionBlocks_ is not defined
```

- [ ] **Step 6: Add `buildLegDescriptionBlocks_`** — insert after `getNextDeparture_`

```javascript
function buildLegDescriptionBlocks_(busTimes, busStops, transitLegs) {
    // Builds the per-leg "Get on / Get off" section for combined multi-leg descriptions.
    // busTimes: [[dept, arrive], ...]   busStops: [[on, off], ...]
    const waits = getTransferWaits_(transitLegs);
    const lines = [];
    for (let i = 0; i < transitLegs.length; i++) {
        const routeNum = transitLegs[i]?.routes?.[0]?.route_short_name || 'Bus';
        const [dept, arrive]  = busTimes[i];
        const [onStop, offStop] = busStops[i] || [null, null];
        const fallback = 'unknown stop | stay vigilant!';

        lines.push(`Leg ${i + 1} — Route ${routeNum}`);
        lines.push(`Get on at:   ${ (onStop  || fallback) + ' @ ' + toRelativeTime_(dept)   }`);
        lines.push(`Get off at:  ${ (offStop || fallback) + ' @ ' + toRelativeTime_(arrive) }`);

        if (i < waits.length) {
            const waitMins = Math.round(waits[i] / 60);
            lines.push('');
            lines.push(`Transfer: ${waitMins} min wait`);
            lines.push('');
        }
    }
    return lines.join('\n');
}
```

- [ ] **Step 7: Run both tests — confirm they pass**

```
Apps Script IDE → select test_getNextDeparture_ → Run ▶
Expected: [PASS] test_getNextDeparture_

Apps Script IDE → select test_buildLegDescriptionBlocks_ → Run ▶
Expected: [PASS] test_buildLegDescriptionBlocks_
```

- [ ] **Step 8: Commit**

```bash
git add AppsScript.gs
git commit -m "Extend getNextDeparture_ with leg index; add buildLegDescriptionBlocks_"
```

---

### Task 7: Add combined multi-leg path to `upsertCommuteEvent_`

**Files:**
- Modify: `AppsScript.gs` — `upsertCommuteEvent_` only

Single-leg path output stays bit-for-bit identical. The only changes are:
1. Compute `transitLegs`, `transfers`, `isSplit`, `isMultiLeg` at the top.
2. When `isMultiLeg`, swap the description body for the `buildLegDescriptionBlocks_` version.

- [ ] **Step 1: Add the test for split detection logic**

```javascript
function test_splitDetection_() {
  // Combined: 2 legs, transfer = 480s (< 900)
  const comboLegs = [
    { start_time: 100, end_time: 200 },
    { start_time: 680, end_time: 800 },
  ];
  const comboWaits = getTransferWaits_(comboLegs);
  const isComboSplit = comboLegs.length === 2 && comboWaits.some(t => t >= 900);
  console.assert(!isComboSplit, 'FAIL: 480s transfer should NOT be split');

  // Split: 2 legs, transfer = 900s (exactly threshold)
  const splitLegs = [
    { start_time: 100, end_time: 200 },
    { start_time: 1100, end_time: 1300 },
  ];
  const splitWaits = getTransferWaits_(splitLegs);
  const isSplit = splitLegs.length === 2 && splitWaits.some(t => t >= 900);
  console.assert(isSplit, 'FAIL: 900s transfer SHOULD be split');

  // 3-leg trip with long transfer → combined-only (isSplit requires exactly 2 legs)
  const threeLegs = [
    { start_time: 100, end_time: 200 },
    { start_time: 1100, end_time: 1200 },
    { start_time: 2200, end_time: 2300 },
  ];
  const threeWaits = getTransferWaits_(threeLegs);
  const isThreeSplit = threeLegs.length === 2 && threeWaits.some(t => t >= 900);
  console.assert(!isThreeSplit, 'FAIL: 3-leg trip should never be split');

  console.log('[PASS] test_splitDetection_');
}
```

- [ ] **Step 2: Run — confirm it passes** (all assertions are pure logic, no new code needed)

```
Apps Script IDE → select test_splitDetection_ → Run ▶
Expected: [PASS] test_splitDetection_
```

- [ ] **Step 3: Modify the opening of `upsertCommuteEvent_`**

Add `transitLegs` alongside the existing declarations, and the three dispatch flags directly after the null-guard. The full opening block of `upsertCommuteEvent_` becomes:

```javascript
function upsertCommuteEvent_(calId, parentEv, itinerary, now) {
    const goTime = new Date(itinerary.start_time * 1000);
    const arrivalTime = new Date(itinerary.end_time * 1000);
    const busNumber = getBusNumber_(itinerary);
    const relevantBusTimes = getRelevantBusTimes_(itinerary);
    const relevantBusStops = getRelevantBusStops_(itinerary);
    const transitLegs = getTransitLegs_(itinerary);

    if (!relevantBusTimes.length) return; // no transit legs found; nothing to upsert

    const relativeLeaveTime = getRelativeTime_(goTime);
    const minsUntilDepart = Math.round((goTime - now) / 60000);
    // Only show the countdown in the title while the departure is upcoming and close
    const within15Minutes = minsUntilDepart >= 0 && minsUntilDepart < 15;
    const busAlreadyLeft = goTime <= now;
    // Surface the next available bus after the planned one has already departed
    const nextDeparture = busAlreadyLeft ? getNextDeparture_(itinerary) : null;

    // Determine trip mode based on transit leg count and transfer waits.
    // Split only when exactly 2 transit legs and the transfer is 15+ min;
    // 3+ legs are always combined regardless of transfer length.
    const transfers = getTransferWaits_(transitLegs);
    const isSplit   = transitLegs.length === 2 && transfers.some(t => t >= 900);
    const isMultiLeg = transitLegs.length >= 2 && !isSplit;
```

- [ ] **Step 4: Add the `isMultiLeg` branch to the `body` description**

Replace the existing `description:` line in `body` with a conditional:

```javascript
    const body = {
        summary,
        description: isMultiLeg
            ? dedent_
                `
                ${ busStatusLine }
                 ➟ Last updated at ${ toRelativeTime_(now) }

                ${ buildLegDescriptionBlocks_(relevantBusTimes, relevantBusStops, transitLegs) }

                Auto-generated by AutoTransit for:
                ${parentEv.summary || "Event Name"} @ ${formatLocation_(parentEv.location) || "Location"}

                ${marker}`.trim()
            : dedent_
                `
                ${ busStatusLine }
                 ➟ Last updated at ${ toRelativeTime_(now) }

                Get on at:   ${ (relevantBusStops[0][0] || parentEv.summary || "unknown stop | stay vigilant!") + " @ " + toRelativeTime_(relevantBusTimes[0][0]) }
                Get off at:   ${ (relevantBusStops[0][1] || parentEv.summary || "unknown stop | stay vigilant!") + " @ " + toRelativeTime_(relevantBusTimes[0][1])}

                Auto-generated by AutoTransit for:
                ${parentEv.summary || "Event Name"} @ ${formatLocation_(parentEv.location) || "Location"}

                ${marker}`.trim(),
        start: { dateTime: goTime.toISOString() },
        end: { dateTime: arrivalTime.toISOString() },
    };
```

- [ ] **Step 5: Also add extras-cleanup to the existing upsert block** (handles split → single/combined transition)

After `Calendar.Events.insert(body, calId)` at the bottom of the function, append:

```javascript
    // Delete extras from a prior split-event state (split → single/combined transition)
    for (let i = 1; i < existing.length; i++) {
        console.log("deleting extra commute event: ", existing[i].summary);
        Calendar.Events.remove(calId, existing[i].id);
    }
```

- [ ] **Step 6: Manual verification** — the function still has no split-path return yet, so `isSplit` has no effect yet. Verify single-leg behaviour is unchanged by checking the Execution log for a real run (or by grepping for any new syntax errors).

```
Apps Script IDE → Run → runPlanner
Expected: no errors; existing single-leg events still created/updated normally
```

- [ ] **Step 7: Commit**

```bash
git add AppsScript.gs
git commit -m "Add combined multi-leg description path to upsertCommuteEvent_"
```

---

### Task 8: Add split event path + final cleanup

**Files:**
- Modify: `AppsScript.gs` — add the `isSplit` early-return block to `upsertCommuteEvent_`, remove all test functions

- [ ] **Step 1: Insert the split path block** immediately after the closing of the dispatch-flags block (after `const isMultiLeg = ...;`) and before the `const parentId` line:

```javascript
    const parentId = parentEv.id;
    const marker = COMMUTE_TAG_PREFIX + parentId;

    // ── SPLIT PATH ──────────────────────────────────────────────────────────
    // When exactly 2 transit legs have a transfer of 15+ min, create two
    // independent calendar events — one per leg — instead of a combined event.
    if (isSplit) {
        // Use a wide window so both legs' events are found in one query
        const splitSearchMin = new Date(itinerary.start_time * 1000 - 6 * 60 * 60 * 1000);
        const splitSearchMax = new Date(itinerary.end_time   * 1000 + 6 * 60 * 60 * 1000);
        const allExisting = Calendar.Events.list(calId, {
            timeMin: splitSearchMin.toISOString(),
            timeMax: splitSearchMax.toISOString(),
            q: marker,
            singleEvents: true,
            maxResults: 10,
        }).items || [];

        // Sort ascending so hits[0] → leg 1 event, hits[1] → leg 2 event
        allExisting.sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));

        // Event 1: start when you leave home → end when you alight from bus 1
        // Event 2: start when you board bus 2 → end when you arrive at class
        const splitBounds = [
            { calStart: new Date(itinerary.start_time      * 1000), calEnd: new Date(transitLegs[0].end_time   * 1000) },
            { calStart: new Date(transitLegs[1].start_time * 1000), calEnd: new Date(itinerary.end_time        * 1000) },
        ];

        for (let i = 0; i < transitLegs.length; i++) {
            const leg = transitLegs[i];
            const isLastLeg = i === transitLegs.length - 1;
            const legBusNum = leg?.routes?.[0]?.route_short_name || 'Bus';
            const legTimes  = relevantBusTimes[i];
            const legStops  = relevantBusStops[i];
            const { calStart, calEnd } = splitBounds[i];

            // Use each leg's own boarding time for the countdown and busAlreadyLeft check
            const legGoTime = new Date(leg.start_time * 1000);
            const legMinsUntilDepart = Math.round((legGoTime - now) / 60000);
            // Only show the countdown in the title while the departure is upcoming and close
            const legWithin15   = legMinsUntilDepart >= 0 && legMinsUntilDepart < 15;
            const legAlreadyLeft = legGoTime <= now;
            const legRelativeTime = getRelativeTime_(legGoTime);
            // Check next departure for this specific leg
            const legNextDepart = legAlreadyLeft ? getNextDeparture_(itinerary, i) : null;

            // Non-last leg title: "🚍 19 to: UCSC - Lower Campus" (transfer stop)
            // Last leg title:     "🚍 16 to: ECE 10"              (class name)
            const toTarget = isLastLeg
                ? (parentEv.summary || '(untitled)')
                : (legStops?.[1] || parentEv.summary || '(untitled)');
            const legSummary = `🚍 ${legBusNum} ${ legWithin15 ? legRelativeTime + ' ' : '' }to: ${toTarget}`;

            // After departure: "Bus left at 10:30 AM. Next departure is at 10:50 AM"
            // Before departure: "Bus leaves in 5 minutes at 10:30 AM"
            const legStatusLine = legAlreadyLeft
                ? `Bus left at ${ toRelativeTime_(legTimes[0]) }` +
                  (legNextDepart ? `. Next departure is at ${ toRelativeTime_(legNextDepart) }` : '')
                : `Bus leaves ${ legRelativeTime } at ${ toRelativeTime_(legTimes[0]) }`;

            const legBody = {
                summary: legSummary,
                description: dedent_
                    `
                    ${legStatusLine}
                     ➟ Last updated at ${ toRelativeTime_(now) }

                    Get on at:   ${ (legStops?.[0] || parentEv.summary || 'unknown stop | stay vigilant!') + ' @ ' + toRelativeTime_(legTimes[0]) }
                    Get off at:   ${ (legStops?.[1] || parentEv.summary || 'unknown stop | stay vigilant!') + ' @ ' + toRelativeTime_(legTimes[1]) }

                    Auto-generated by AutoTransit for:
                    ${parentEv.summary || 'Event Name'} @ ${formatLocation_(parentEv.location) || 'Location'}

                    ${marker}`.trim(),
                start: { dateTime: calStart.toISOString() },
                end:   { dateTime: calEnd.toISOString() },
            };

            if (allExisting[i]) {
                console.log('updating split event ' + (i + 1) + ': ', legSummary);
                Calendar.Events.patch(legBody, calId, allExisting[i].id);
            } else {
                console.log('creating split event ' + (i + 1) + ': ', legSummary);
                Calendar.Events.insert(legBody, calId);
            }
        }

        // Delete extras from a prior single/combined state (split→single/combined transition)
        for (let i = transitLegs.length; i < allExisting.length; i++) {
            console.log('deleting extra commute event: ', allExisting[i].summary);
            Calendar.Events.remove(calId, allExisting[i].id);
        }
        return; // skip the single/combined-event path below
    }
    // ── END SPLIT PATH ───────────────────────────────────────────────────────
```

> The `parentId` and `marker` declarations that were already in the function must be moved up so they sit before the `if (isSplit)` block. Everything else in the function (the `existing` search, `summary`, `body`, patch/insert, extras-cleanup) remains unchanged below the `return`.

- [ ] **Step 2: Verify the complete final shape of `upsertCommuteEvent_`**

The function should now read, in order:

1. `const goTime`, `arrivalTime`, `busNumber`, `relevantBusTimes`, `relevantBusStops`, `transitLegs`
2. `if (!relevantBusTimes.length) return;`
3. `const relativeLeaveTime`, `minsUntilDepart`, `within15Minutes`, `busAlreadyLeft`, `nextDeparture`
4. `const transfers`, `isSplit`, `isMultiLeg`
5. `const parentId`, `const marker`
6. `// ── SPLIT PATH ──` … `return;`
7. `// ── SINGLE / COMBINED PATH ──` (`existing` search, `summary`, `busStatusLine`, `body` with isMultiLeg ternary, patch/insert, extras-cleanup)

- [ ] **Step 3: Remove all test functions** that were added in Tasks 1–7

Delete these functions entirely from `AppsScript.gs`:
- `test_getTransitLegs_`
- `test_getRelevantBusTimes_`
- `test_getRelevantBusStops_`
- `test_getBusNumber_`
- `test_getTransferWaits_`
- `test_splitDetection_`
- `test_getNextDeparture_`
- `test_buildLegDescriptionBlocks_`

- [ ] **Step 4: Final manual smoke-test** — run `runPlanner` against a real calendar and verify:
  - A single-leg upcoming event produces an unchanged-format entry
  - No console errors

```
Apps Script IDE → Run → runPlanner
Expected: no errors; "creating:" or "updating:" log lines; no "split event" logs unless a 2-leg trip with 15+ min transfer exists
```

- [ ] **Step 5: Final commit**

```bash
git add AppsScript.gs
git commit -m "Add multi-leg transit support with split-event logic"
```

---

## Self-Review Checklist

| Spec requirement | Covered by |
|---|---|
| `getTransitLegs_` new helper | Task 1 |
| `getRelevantBusTimes_` → array of pairs | Task 2 |
| `getRelevantBusStops_` → array of pairs | Task 3 |
| `getBusNumber_` → joined route names | Task 4 |
| Transfer wait calculation | Task 5 |
| `getNextDeparture_` leg-index extension | Task 6 |
| `buildLegDescriptionBlocks_` | Task 6 |
| Combined multi-leg description format | Task 7 |
| Extras-cleanup (split → single transition) | Task 7 step 5 |
| Split detection (exactly 2 legs, ≥ 900s) | Task 7 step 1 + Task 8 |
| Split event titles (transfer stop / class name) | Task 8 |
| Split event time bounds (event1: itin→leg1, event2: leg2→itin) | Task 8 |
| Sort-match update mechanism | Task 8 |
| Single-leg output unchanged | Task 2–4 (callers updated), Task 7 (ternary) |
| Silent API failures preserved | Untouched |
| Footer format preserved | Tasks 7 & 8 (same `dedent_` block) |
| Test functions removed before final commit | Task 8 step 3 |
