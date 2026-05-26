const NEED_TRANSIT_THRESHOLD_MINS = 90;
const COMMUTE_TAG_PREFIX = "auto_commute_parent=";
const CLEANUP_PAGE_TOKEN_PROP = "CLEANUP_PAST_COMMUTE_TITLES_PAGE_TOKEN_DO_NOT_MANUALLY_MODIFY";
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
    const events = allEvents.filter((e) => isFutureTimedEvent_(e, now));
    const changeTracker = createEventChangeTracker_();
    
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
            if (!ev?.start?.dateTime) continue; // skip all-day or malformed events
            const eventStart = new Date(ev.start.dateTime);
            if (!shouldProcess_(ev, allEvents, targetCalendar, now, eventStart))
                continue;
            if (!ev.location) continue; // nowhere to route to
            const destLL = geocodeOrThrow_(ev.location);

            const plan = transitPlanArriveBy_(apiKey, homeLL, destLL, eventStart);
            if (!plan) continue; // API call failed silently (e.g. rate-limit)
            const itinerary = pickBestItinerary_(plan, eventStart);
            if (!itinerary) continue;
            const vehicleOccupancies = getVehicleOccupanciesForItinerary_(apiKey, itinerary);

            // Create a buffer ending at the meeting start; if routing arrives earlier, you can pad later.
            upsertCommuteEvent_(targetCalendar, ev, itinerary, now, vehicleOccupancies, changeTracker);
        } catch (e) {
            // Fail silently -- likely a rate-limit or transient API error
            console.log("Skipping event '" + (ev.summary || ev.id) + "': " + e.message);
        } finally {
            // Run this on try or fail
            Utilities.sleep(10000); // I think transitAPI rate limit is 6 calls per minute -> 10s per call
        }
    }

    logEventChangeSummary_(changeTracker);
}

function shouldProcess_(ev, allEvents, targetCalendar, now, eventStart) {
    const realtime_threshold = 25;
    const thresholdStart = new Date(
        eventStart.getTime() - minsToMs_(NEED_TRANSIT_THRESHOLD_MINS),
    );
    const recentEvents = allEvents.filter((e) => {
        if (!e?.start?.dateTime || !e?.end?.dateTime) return false;
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

    const timedRecentTargetEvents = sortTimedEventsByStart_(recentTargetEvents);

    if (timedRecentTargetEvents.length !== 0) {
        // We have an AutoTransit entry: does it need updating?
        const autoTransitEntry = timedRecentTargetEvents[0];
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
    return timedRecentTargetEvents.length === 0; // Process if no recent timed target events
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
    const arrival_time_s = Math.floor(arriveByDate.getTime() / 1000);
    const qs = {
        from_lat: fromLL.lat,
        from_lon: fromLL.lon,
        to_lat: toLL.lat,
        to_lon: toLL.lon,
        arrival_time: arrival_time_s,
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
    const itineraries = (plan?.results || []).filter(result =>
        typeof result?.start_time === 'number' &&
        typeof result.end_time === 'number'
    );
    if (!itineraries.length) return null;
    // Compare in unix seconds to match the API's end_time field
    const idealTime = Math.floor(eventStart.getTime() / 1000) - 10 * 60;
    let bestResult = itineraries[0];
    let bestDiff = Math.abs(idealTime - bestResult.end_time);

    for (const result of itineraries.slice(1)) {
        const diff = Math.abs(idealTime - result.end_time);
        if (diff < bestDiff) {
            bestResult = result;
            bestDiff = diff;
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
    return (itinerary?.legs || []).filter(l =>
        l?.leg_mode === 'transit' &&
        typeof l.start_time === 'number' &&
        typeof l.end_time === 'number'
    );
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

function extractVehicleRequestsForItinerary_(itinerary) {
    const requests = [];
    const legs = itinerary?.legs || [];
    let transitLegIndex = 0;

    for (const leg of legs) {
        if (leg.leg_mode !== "transit") continue;

        const route = leg?.routes?.[0];
        const isBus = route?.route_type === 3 || route?.vehicle?.name === "bus";
        const globalRouteId = route?.global_route_id;
        if (isBus && globalRouteId) {
            const directionId = route?.itineraries?.[0]?.direction_id;
            requests.push({
                legIndex: transitLegIndex,
                globalRouteId,
                directionId,
            });
        }

        transitLegIndex++;
    }

    return requests;
}

function fetchVehicleOccupancy_(apiKey, globalRouteId, directionId) {
    const qs = { global_route_id: globalRouteId };
    if (directionId === 0 || directionId === 1) qs.direction_id = directionId;

    const url = "https://external.transitapp.com/v4/vehicles?" + toQuery_(qs);
    try {
        const resp = UrlFetchApp.fetch(url, {
            method: "get",
            headers: { apiKey: apiKey },
            muteHttpExceptions: true,
        });
        if (resp.getResponseCode() >= 300) {
            console.log(
                "Transit vehicles API returned " +
                    resp.getResponseCode() +
                    ": " +
                    resp.getContentText(),
            );
            return null;
        }

        const vehicles = JSON.parse(resp.getContentText())?.vehicles || [];
        return vehicles[0]?.occupancy_status ?? null;
    } catch (e) {
        console.log("Transit vehicles API fetch failed (silent): " + e.message);
        return null;
    }
}

function getVehicleOccupanciesForItinerary_(apiKey, itinerary) {
    const occupancies = {};
    const requests = extractVehicleRequestsForItinerary_(itinerary);

    for (const request of requests) {
        const occupancy = fetchVehicleOccupancy_(
            apiKey,
            request.globalRouteId,
            request.directionId,
        );
        if (occupancy) occupancies[request.legIndex] = occupancy;
        Utilities.sleep(10000);
    }

    return occupancies;
}

function getOccupancyText_(occupancyStatus) {
    switch (occupancyStatus) {
        case 1:
            return "not crowded";
        case 2:
            return "some crowding";
        case 3:
            return "crowded";
        default:
            return "";
    }
}

function buildCrowdingLine_(leg, occupancyStatus) {
    const occupancyText = getOccupancyText_(occupancyStatus);
    if (!occupancyText) return "";

    let line = "Crowding: " + occupancyText;
    if (occupancyStatus === 3) {
        const departures = leg?.departures || [];
        if (departures.length >= 2) {
            const nextDeparture = new Date(departures[1].departure_time * 1000);
            line += ". If skipped, next departure is at " + toRelativeTime_(nextDeparture);
        }
    }

    return line;
}

function formatOptionalDescriptionLine_(line) {
    return line ? line + "\n" : "";
}

function formatStopName_(stopName, parentSummary) {
    return stopName || parentSummary || 'unknown stop | stay vigilant!';
}

function sortTimedEventsByStart_(events) {
    return events
        .filter(event => event?.start?.dateTime)
        .sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));
}

function isFutureTimedEvent_(event, now) {
    return !!event?.start?.dateTime && new Date(event.start.dateTime) > now;
}

function buildLegDescriptionBlocks_(busTimes, busStops, transitLegs, parentSummary, vehicleOccupancies) {
    // Builds the per-leg "Get on / Get off" section for combined multi-leg descriptions.
    // busTimes: [[dept, arrive], ...]   busStops: [[on, off], ...]
    const waits = getTransferWaits_(transitLegs);
    const lines = [];
    for (let i = 0; i < transitLegs.length; i++) {
        const routeNum = transitLegs[i]?.routes?.[0]?.route_short_name || 'Bus';
        const [dept, arrive]    = busTimes[i];
        const [onStop, offStop] = busStops[i] || [null, null];

        lines.push(`Leg ${i + 1} — Route ${routeNum}`);
        const crowdingLine = buildCrowdingLine_(transitLegs[i], vehicleOccupancies?.[i]);
        if (crowdingLine) lines.push(crowdingLine);
        lines.push(`Get on at:   ${ formatStopName_(onStop, parentSummary) + ' @ ' + toRelativeTime_(dept) }`);
        lines.push(`Get off at:  ${ formatStopName_(offStop, parentSummary) + ' @ ' + toRelativeTime_(arrive) }`);

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

function createEventChangeTracker_() {
    return {
        count: 0,
        log: (line) => console.log(line),
    };
}

function formatEventChangeLogLine_(action, busNumber, destination, date) {
    const normalizedAction = (action || "changed").toLowerCase();
    const formattedAction = normalizedAction.charAt(0).toUpperCase() + normalizedAction.slice(1);
    const formattedBus = busNumber || "Bus";
    const formattedDestination = destination || "(untitled)";
    const formattedDate = date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
    });

    return `${formattedAction} ${formattedBus} to ${formattedDestination} on ${formattedDate}`;
}

function recordEventChange_(tracker, change) {
    if (!tracker) return;

    tracker.count++;
    tracker.log(formatEventChangeLogLine_(
        change.action,
        change.busNumber,
        change.destination,
        change.date,
    ));
}

function logEventChangeSummary_(tracker) {
    const count = tracker?.count || 0;
    console.log(`AutoTransit made ${count} ${count === 1 ? "change" : "changes"}.`);
}

function parseEventChangeDetailsFromSummary_(summary) {
    const fallback = {
        busNumber: "Bus",
        destination: summary || "(untitled)",
    };
    if (!summary) return fallback;

    const match = summary.match(/^(?::oncoming_bus:|🚍)\s+(.+?)\s+to:\s+(.+)$/);
    if (!match) return fallback;

    const busNumber = match[1]
        .replace(/\s+(?:this minute|in \d+ minutes?)$/, "")
        .trim();
    return {
        busNumber: busNumber || "Bus",
        destination: match[2] || "(untitled)",
    };
}

function upsertCommuteEvent_(calId, parentEv, itinerary, now, vehicleOccupancies, changeTracker) {
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

        // Sort ascending so hits[0] → leg 1 event, hits[1] → leg 2 event.
        // Ignore all-day marker matches; split commute events are always timed.
        const timedExisting = sortTimedEventsByStart_(allExisting);

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
            const crowdingLine = buildCrowdingLine_(leg, vehicleOccupancies?.[i]);

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

                    ${formatOptionalDescriptionLine_(crowdingLine)}
                    Get on at:   ${ formatStopName_(legStops?.[0], parentEv.summary) + ' @ ' + toRelativeTime_(legTimes[0]) }
                    Get off at:   ${ formatStopName_(legStops?.[1], parentEv.summary) + ' @ ' + toRelativeTime_(legTimes[1]) }

                    Auto-generated by AutoTransit for:
                    ${parentEv.summary || 'Event Name'} @ ${formatLocation_(parentEv.location) || 'Location'}

                    ${marker}`.trim(),
                start: { dateTime: calStart.toISOString() },
                end:   { dateTime: calEnd.toISOString() },
            };

            if (timedExisting[i]) {
                Calendar.Events.patch(legBody, calId, timedExisting[i].id);
                recordEventChange_(changeTracker, {
                    action: "updated",
                    busNumber: legBusNum,
                    destination: toTarget,
                    date: calStart,
                });
            } else {
                Calendar.Events.insert(legBody, calId);
                recordEventChange_(changeTracker, {
                    action: "made",
                    busNumber: legBusNum,
                    destination: toTarget,
                    date: calStart,
                });
            }
        }

        // Delete extras from a prior single/combined state (split→single/combined transition)
        for (let i = transitLegs.length; i < timedExisting.length; i++) {
            const changeDetails = parseEventChangeDetailsFromSummary_(timedExisting[i].summary);
            Calendar.Events.remove(calId, timedExisting[i].id);
            recordEventChange_(changeTracker, {
                action: "deleted",
                busNumber: changeDetails.busNumber,
                destination: changeDetails.destination,
                date: new Date(timedExisting[i].start.dateTime),
            });
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
    const timedExisting = sortTimedEventsByStart_(existing);

    const summary = `🚍 ${busNumber || "Bus"} ${ within15Minutes ? relativeLeaveTime + " " : "" }to: ${parentEv.summary || "(untitled)"}`;

    // After departure: "Bus left at 10:30 AM. Next departure is at 10:50 AM"
    // Before departure: "Bus leaves in 5 minutes at 10:30 AM"
    const busStatusLine = busAlreadyLeft
        ? `Bus left at ${ toRelativeTime_(relevantBusTimes[0][0]) }` +
          (nextDeparture ? `. Next departure is at ${ toRelativeTime_(nextDeparture) }` : "")
        : `Bus leaves ${ relativeLeaveTime } at ${ toRelativeTime_(relevantBusTimes[0][0]) }`;
    const crowdingLine = buildCrowdingLine_(transitLegs[0], vehicleOccupancies?.[0]);

    const body = {
        summary,
        description: isMultiLeg
            ? dedent_
                `
                ${ busStatusLine }
                 ➟ Last updated at ${ toRelativeTime_(now) }

                ${ buildLegDescriptionBlocks_(relevantBusTimes, relevantBusStops, transitLegs, parentEv.summary, vehicleOccupancies) }

                Auto-generated by AutoTransit for:
                ${parentEv.summary || "Event Name"} @ ${formatLocation_(parentEv.location) || "Location"}

                ${marker}`.trim()
            : dedent_
                `
                ${ busStatusLine }
                 ➟ Last updated at ${ toRelativeTime_(now) }

                ${formatOptionalDescriptionLine_(crowdingLine)}
                Get on at:   ${ formatStopName_(relevantBusStops[0]?.[0], parentEv.summary) + " @ " + toRelativeTime_(relevantBusTimes[0][0]) }
                Get off at:   ${ formatStopName_(relevantBusStops[0]?.[1], parentEv.summary) + " @ " + toRelativeTime_(relevantBusTimes[0][1])}

                Auto-generated by AutoTransit for:
                ${parentEv.summary || "Event Name"} @ ${formatLocation_(parentEv.location) || "Location"}

                ${marker}`.trim(),
        start: { dateTime: goTime.toISOString() },
        end: { dateTime: arrivalTime.toISOString() },
    };

    if (timedExisting.length) {
        Calendar.Events.patch(body, calId, timedExisting[0].id);
        recordEventChange_(changeTracker, {
            action: "updated",
            busNumber: busNumber || "Bus",
            destination: parentEv.summary || "(untitled)",
            date: goTime,
        });
    } else {
        Calendar.Events.insert(body, calId);
        recordEventChange_(changeTracker, {
            action: "made",
            busNumber: busNumber || "Bus",
            destination: parentEv.summary || "(untitled)",
            date: goTime,
        });
    }

    // Delete extras from a prior split-event state (split → single/combined transition)
    for (let i = 1; i < timedExisting.length; i++) {
        const changeDetails = parseEventChangeDetailsFromSummary_(timedExisting[i].summary);
        Calendar.Events.remove(calId, timedExisting[i].id);
        recordEventChange_(changeTracker, {
            action: "deleted",
            busNumber: changeDetails.busNumber,
            destination: changeDetails.destination,
            date: new Date(timedExisting[i].start.dateTime),
        });
    }
}

function cleanCommuteSummaryCountdown_(summary) {
    if (!summary) return summary;
    return summary.replace(
        /^((?::oncoming_bus:|🚍)\s+.+?)\s+(?:this minute|in \d+ minutes?)\s+(to:\s+)/,
        "$1 $2",
    );
}

function cleanupPastCommuteEventTitles() {
    const props = PropertiesService.getScriptProperties();
    const targetCalendar =
        props.getProperty("TARGET_CALENDAR_ID") || "AutoTransit";
    const result = cleanupPastCommuteEventTitlesBatch_(targetCalendar, {
        pageToken: props.getProperty(CLEANUP_PAGE_TOKEN_PROP),
    });

    if (result.nextPageToken) {
        props.setProperty(CLEANUP_PAGE_TOKEN_PROP, result.nextPageToken);
    } else if (!result.stoppedEarly) {
        props.deleteProperty(CLEANUP_PAGE_TOKEN_PROP);
    }
}

function cleanupPastCommuteEventTitlesBatch_(calId, options) {
    options = options || {};
    const now = options.now || new Date();
    const timeMin = options.timeMin || new Date(2000, 0, 1);
    const maxUpdates = options.maxUpdates || 50;
    const sleepMs = options.sleepMs ?? 250;
    const pageToken = options.pageToken || null;

    const params = {
        timeMin: timeMin.toISOString(),
        timeMax: now.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
    };
    if (pageToken) params.pageToken = pageToken;

    const result = Calendar.Events.list(calId, params);
    const events = result.items || [];
    let updated = 0;

    for (const ev of events) {
        const end = new Date(ev?.end?.dateTime || ev?.end?.date || 0);
        if (!(end < now)) continue;

        const cleanSummary = cleanCommuteSummaryCountdown_(ev.summary);
        if (cleanSummary === ev.summary) continue;

        Calendar.Events.patch({ summary: cleanSummary }, calId, ev.id);
        updated++;
        if (sleepMs > 0) Utilities.sleep(sleepMs);
        if (updated >= maxUpdates) {
            console.log(
                "Updated " + updated +
                " event titles. Run cleanupPastCommuteEventTitles() again to continue.",
            );
            return { updated, nextPageToken: result.nextPageToken || null, stoppedEarly: true };
        }
    }

    console.log(
        "Updated " + updated +
        " event titles." +
        (result.nextPageToken ? " Run cleanupPastCommuteEventTitles() again for the next page." : ""),
    );
    return { updated, nextPageToken: result.nextPageToken || null, stoppedEarly: false };
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
