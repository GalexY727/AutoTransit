const NEED_TRANSIT_THRESHOLD_MINS = 90;
const COMMUTE_TAG_PREFIX = "auto_commute_parent=";
const SPLIT_TRANSFER_THRESHOLD_SECS = 15 * 60; // 900 s — transfers at or above this use split events
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });


function runPlanner() {
    const props = PropertiesService.getScriptProperties();
    const apiKey = props.getProperty("TRANSIT_API_KEY");
    const homeAddress = props.getProperty("HOME_ADDRESS");
    const lastHomeAddress = props.getProperty(
        "LAST_HOME_ADDRESS_DO_NOT_MANUALLY_MODIFY",
    );
    let homeLL = JSON.parse(
        props.getProperty("HOME_LL_DO_NOT_MANUALLY_MODIFY"),
    );
    const targetCalendar =
        props.getProperty("TARGET_CALENDAR_ID") || "AutoTransit";
    const sourceCalendar =
        props.getProperty("SOURCE_CALENDAR_ID") || "UCSC Classes";
    if (!apiKey || !homeAddress)
        throw new Error("Missing TRANSIT_API_KEY or HOME_ADDRESS");

    const now = new Date();
    // NOTE: 18/20 schedule goes only 47 days into the future
    // So max horizon is now.getTime() + (24 * 60 * 60 * 1000 * 47)
    const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000); // next 24h
    const thresholdStart = new Date(
        now.getTime() - minsToMs_(NEED_TRANSIT_THRESHOLD_MINS),
    );

    // Pull events from threshold to horizon in one call
    const allEvents =
        Calendar.Events.list(sourceCalendar, {
            timeMin: thresholdStart.toISOString(),
            timeMax: horizon.toISOString(),
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 250,
        }).items || [];

    // Separate recent and upcoming events in memory
    const events = allEvents.filter((e) => new Date(e.start.dateTime) > now);
    
    // Pre-geocode home only when env_var changes
    if (homeAddress !== lastHomeAddress) {
        props.setProperty(
            "LAST_HOME_ADDRESS_DO_NOT_MANUALLY_MODIFY",
            homeAddress,
        );

        const homeLL_temp = geocodeOrThrow_(homeAddress);

        // Store as JSON string
        props.setProperty(
            "HOME_LL_DO_NOT_MANUALLY_MODIFY",
            JSON.stringify(homeLL_temp),
        );

        homeLL = homeLL_temp;
        console.log("Updating automatic env vars");
    }

    for (const ev of events) {
        try {
            const eventStart = new Date(ev.start.dateTime);
            if (!shouldProcess_(ev, allEvents, targetCalendar, now, eventStart))
                continue;
            if (!ev.start || !ev.start.dateTime) continue; // skip all-day
            if (!ev.location) continue; // nowhere to route to
            const destLL = geocodeOrThrow_(ev.location);

            const plan = transitPlanArriveBy_(apiKey, homeLL, destLL, eventStart);
            if (!plan) continue; // API call failed silently (e.g. rate-limit)
            const itinerary = pickBestItinerary_(plan, eventStart);
            if (!itinerary) continue;

            // Create a buffer ending at the meeting start; if routing arrives earlier, you can pad later.
            upsertCommuteEvent_(targetCalendar, ev, itinerary, now);
            Utilities.sleep(10000); // I think transitAPI rate limit is 6 calls per minute -> 10s per call
        } catch (e) {
            // Fail silently -- likely a rate-limit or transient API error
            console.log("Skipping event '" + (ev.summary || ev.id) + "': " + e.message);
        }
    }
}

function shouldProcess_(ev, allEvents, targetCalendar, now, eventStart) {
    const realtime_threshold = 25;
    const thresholdStart = new Date(
        eventStart.getTime() - minsToMs_(NEED_TRANSIT_THRESHOLD_MINS),
    );
    const recentEvents = allEvents.filter((e) => {
        const eStart = new Date(e.start.dateTime);
        const eEnd = new Date(e.end.dateTime);
        return ((eStart > thresholdStart || eEnd > thresholdStart) && eStart < eventStart); 
        // eEnd is evaluated in case an event ended at the 'top' of the window.
        // we don't care if eEnd < eventStart or not
    });

    // Check if there are events on sourceCalendar in the past need_transit_threshold_minutes
    if (recentEvents.length > 0) {
        return false; // Skip if there are recent events -- already on campus
    }

    // Entries in targetCalendar (AutoTransit) in the past 60 minutes from event start time
    const targetThresholdStart = new Date(eventStart.getTime() - minsToMs_(60));
    const recentTargetEvents =
        Calendar.Events.list(targetCalendar, {
            timeMin: targetThresholdStart.toISOString(),
            timeMax: eventStart.toISOString(),
            singleEvents: true,
            maxResults: 250,
        }).items || [];

    if (recentTargetEvents.length !== 0) {
        // We have an AutoTransit entry: does it need updating?
        const autoTransitEntry = recentTargetEvents[0];
        const timeUntilDepart = new Date(autoTransitEntry.start.dateTime).getTime() - now.getTime();
        // Check if event is soon enough for realtime updating -- 'realtime' updating
        // The second clause is to force the event to double check for late arrivals
        // and to reset event name to no longer include relative timestamp in summary
        if (timeUntilDepart <= minsToMs_(realtime_threshold) && timeUntilDepart > -5) {
            return true;
        }
    }

    // Check if there is NOT an entry in targetCalendar (AutoTransit) in the past 60 minutes
    // * from the event start time
    return recentTargetEvents.length === 0; // Process if no recent target events
}

// Uses Apps Script Maps service geocoder
function geocodeOrThrow_(address) {
    const res = Maps.newGeocoder().geocode(address);
    if (!res || res.status !== "OK" || !res.results || !res.results.length) {
        throw new Error(
            "Failed to geocode: " + address + " status=" + (res && res.status),
        );
    }
    const loc = res.results[0].geometry.location;
    return { lat: loc.lat, lon: loc.lng };
}

function transitPlanArriveBy_(apiKey, fromLL, toLL, arriveByDate) {
    const arrival_time_ms = Math.floor(arriveByDate.getTime() / 1000);
    const qs = {
        from_lat: fromLL.lat,
        from_lon: fromLL.lon,
        to_lat: toLL.lat,
        to_lon: toLL.lon,
        arrival_time: arrival_time_ms,
        should_update_realtime: true,
        consider_downtimes: true,
        max_num_departures: 2, // fetch the next departure so we can surface it after the bus leaves
    };

    const url =
        "https://external.transitapp.com/v4/public/plan?" + toQuery_(qs);
    try {
        const resp = UrlFetchApp.fetch(url, {
            method: "get",
            headers: { apiKey: apiKey },
            muteHttpExceptions: true,
        });
        if (resp.getResponseCode() >= 300) {
            // Fail silently (e.g. rate-limit); caller checks for null
            console.log(
                "Transit API returned " +
                    resp.getResponseCode() +
                    ": " +
                    resp.getContentText(),
            );
            return null;
        }
        return JSON.parse(resp.getContentText());
    } catch (e) {
        console.log("Transit API fetch failed (silent): " + e.message);
        return null;
    }
}

// Pick the itinerary that arrives closest to 10 minutes before the event start
function pickBestItinerary_(plan, eventStart) {
    const itineraries = plan?.results || [];
    // Compare in unix seconds to match the API's end_time field
    const idealTime = Math.floor(eventStart.getTime() / 1000) - 10 * 60;
    let bestResult = itineraries[0];

    for (const result of itineraries.slice(1)) {
        const time = result?.end_time;
        if (!time) continue;

        const diff = Math.abs(idealTime - time);
        if (diff < Math.abs(idealTime - bestResult.end_time)) {
            bestResult = result;
        }
    }
    return bestResult || null;
}

function getBusNumber_(itinerary) {
    // For multi-leg trips, joins all route short names with " → " (e.g. "19 → 16").
    // Single-leg output is unchanged.
    const busNums = getTransitLegs_(itinerary)
        .map(leg => leg?.routes?.[0]?.route_short_name)
        .filter(Boolean);
    return busNums.length ? busNums.join(' → ') : null;
}

function getTransitLegs_(itinerary) {
    return (itinerary?.legs || []).filter(l => l.leg_mode === 'transit');
}

function getTransferWaits_(transitLegs) {
    // Returns an array of wait times in seconds between consecutive transit legs.
    // Clamped to 0 to handle real-time anomalies where leg N+1 departs before leg N arrives.
    const waits = [];
    for (let i = 0; i < transitLegs.length - 1; i++) {
        waits.push(Math.max(0, transitLegs[i + 1].start_time - transitLegs[i].end_time));
    }
    return waits;
}

function getRelevantBusTimes_(itinerary) {
    // Returns [[depart, arrive], ...] — one pair per transit leg in order
    return getTransitLegs_(itinerary).map(leg => [
        new Date(leg.start_time * 1000),
        new Date(leg.end_time * 1000),
    ]);
}

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

function buildLegDescriptionBlocks_(busTimes, busStops, transitLegs) {
    // Builds the per-leg "Get on / Get off" section for combined multi-leg descriptions.
    // busTimes: [[dept, arrive], ...]   busStops: [[on, off], ...]
    const waits = getTransferWaits_(transitLegs);
    const lines = [];
    for (let i = 0; i < transitLegs.length; i++) {
        const routeNum = transitLegs[i]?.routes?.[0]?.route_short_name || 'Bus';
        const [dept, arrive]    = busTimes[i];
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

// Example outputs: in 5 minutes, in 2 hours, tomorrow
function getRelativeTime_(futureDate) {
    const diffMs = futureDate - new Date();

    const minutes = Math.round(diffMs / 60000);
    if (minutes < 60) return rtf.format(minutes, 'minute');

    const hours = Math.round(diffMs / 3600000);
    if (hours < 24) return rtf.format(hours, 'hour');

    const days = Math.round(diffMs / 86400000);
    return rtf.format(days, 'day');
}

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
    const isSplit    = transitLegs.length === 2 && transfers.some(t => t >= SPLIT_TRANSFER_THRESHOLD_SECS);
    const isMultiLeg = transitLegs.length >= 2 && !isSplit;

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

        for (let i = 0; i < splitBounds.length; i++) {
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
            const legWithin15    = legMinsUntilDepart >= 0 && legMinsUntilDepart < 15;
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

                    Get on at:   ${ (legStops?.[0] || 'unknown stop | stay vigilant!') + ' @ ' + toRelativeTime_(legTimes[0]) }
                    Get off at:   ${ (legStops?.[1] || 'unknown stop | stay vigilant!') + ' @ ' + toRelativeTime_(legTimes[1]) }

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

    // Find existing commute event in a small window
    const searchMin = new Date(goTime.getTime() - 6 * 60 * 60 * 1000);
    const searchMax = new Date(arrivalTime.getTime() + 6 * 60 * 60 * 1000);

    const existing =
        Calendar.Events.list(calId, {
            timeMin: searchMin.toISOString(),
            timeMax: searchMax.toISOString(),
            q: marker,
            singleEvents: true,
            maxResults: 10,
        }).items || [];

    const summary = `🚍 ${busNumber || "Bus"} ${ within15Minutes ? relativeLeaveTime + " " : "" }to: ${parentEv.summary || "(untitled)"}`;

    // After departure: "Bus left at 10:30 AM. Next departure is at 10:50 AM"
    // Before departure: "Bus leaves in 5 minutes at 10:30 AM"
    const busStatusLine = busAlreadyLeft
        ? `Bus left at ${ toRelativeTime_(relevantBusTimes[0][0]) }` +
          (nextDeparture ? `. Next departure is at ${ toRelativeTime_(nextDeparture) }` : "")
        : `Bus leaves ${ relativeLeaveTime } at ${ toRelativeTime_(relevantBusTimes[0][0]) }`;

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

                Get on at:   ${ (relevantBusStops[0][0] || "unknown stop | stay vigilant!") + " @ " + toRelativeTime_(relevantBusTimes[0][0]) }
                Get off at:   ${ (relevantBusStops[0][1] || "unknown stop | stay vigilant!") + " @ " + toRelativeTime_(relevantBusTimes[0][1])}

                Auto-generated by AutoTransit for:
                ${parentEv.summary || "Event Name"} @ ${formatLocation_(parentEv.location) || "Location"}

                ${marker}`.trim(),
        start: { dateTime: goTime.toISOString() },
        end: { dateTime: arrivalTime.toISOString() },
    };

    if (existing.length) {
        console.log("updating: ", summary);
        Calendar.Events.patch(body, calId, existing[0].id);
    } else {
        console.log("creating: ", summary);
        Calendar.Events.insert(body, calId);
    }

    // Delete extras from a prior split-event state (split → single/combined transition)
    for (let i = 1; i < existing.length; i++) {
        console.log("deleting extra commute event: ", existing[i].summary);
        Calendar.Events.remove(calId, existing[i].id);
    }
}

function toQuery_(obj) {
    return Object.keys(obj)
        .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]))
        .join("&");
}

function minsToMs_(mins) {
    return mins * 60 * 1000;
}

function dedent_(strings, ...values) {
  let raw = strings.reduce((acc, s, i) => acc + s + (values[i] ?? ""), "");
  raw = raw.replace(/^\n/, "").replace(/\n[ \t]+/g, "\n");
  return raw.trim();
}

function toRelativeTime_(date) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatLocation_(location) {
  if (!location) return '';

  const parts = location.split(',').map(p => p.trim());
  return parts.slice(0, 2).join(', ');
}
