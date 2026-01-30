const NEED_TRANSIT_THRESHOLD_MINS = 90;
const COMMUTE_TAG_PREFIX = "auto_commute_parent=";
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
        const eventStart = new Date(ev.start.dateTime);
        if (!shouldProcess_(ev, allEvents, targetCalendar, now, eventStart))
            continue;
        if (!ev.start || !ev.start.dateTime) continue; // skip all-day
        if (!ev.location) continue; // nowhere to route to
        const destLL = geocodeOrThrow_(ev.location);

        const plan = transitPlanArriveBy_(apiKey, homeLL, destLL, eventStart);
        const itinerary = pickBestItinerary_(plan, eventStart);
        if (!itinerary) continue;

        // Create a buffer ending at the meeting start; if routing arrives earlier, you can pad later.
        upsertCommuteEvent_(targetCalendar, ev, itinerary, now);
        Utilities.sleep(10000); // I think transitAPI rate limit is 6 calls per minute -> 10s per call
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
        consider_downtime: true,
    };

    const url =
        "https://external.transitapp.com/v3/public/plan?" + toQuery_(qs);
    const resp = UrlFetchApp.fetch(url, {
        method: "get",
        headers: { apiKey: apiKey },
        muteHttpExceptions: true,
    });
    if (resp.getResponseCode() >= 300) {
        throw new Error(
            "Transit plan failed: " +
                resp.getResponseCode() +
                " " +
                resp.getContentText(),
        );
    }
    return JSON.parse(resp.getContentText());
}

// Pick the itinerary that arrives closest to 10 minutes before the event start
function pickBestItinerary_(plan, eventStart) {
    const itineraries = plan?.results || [];
    const idealTime = eventStart.setMinutes(eventStart.getMinutes() - 10);
    let bestResult = itineraries[0];

    for (const result of itineraries.slice(1)) {
        const time = result?.end_time;
        if (!time) continue;

        const diff = Math.abs(idealTime - time);
        if (diff < Math.abs(idealTime - bestResult.endTime)) {
            bestResult = result;
        }
    }
    return bestResult || null;
}

function getBusNumber_(itinerary) {
    const legs = itinerary?.legs || [];
    for (const leg of legs) {
        if (leg.leg_mode !== "transit") continue;
        const busNumber = leg?.routes[0]?.route_short_name;
        if (!busNumber) continue;
        return busNumber;
    }
    return null;
}

function getRelevantBusTimes_(itinerary) {
    const legs = itinerary?.legs || [];
    for (const leg of legs) {
        if (leg.leg_mode !== "transit") continue;
        const departureTime = leg?.start_time;
        if (!departureTime) continue;
        const arrival_time = leg.end_time;
        return [new Date(departureTime * 1000), new Date(arrival_time * 1000)];
    }
    return null;
}

function getRelevantBusStops_(itinerary) {
    const legs = itinerary?.legs || [];
    const stops = []; // strings
    for (const leg of legs) {
        if (leg.leg_mode !== "transit") continue;
        const itinerary = leg?.routes[0]?.itineraries[0];
        if (!itinerary) continue;
        const plan_details = itinerary?.plan_details;
        if (!plan_details) continue;
        
        const start = plan_details.start_stop_offset;
        const end = plan_details.end_stop_offset;

        stops.push(itinerary.stops[start].stop_name)
        stops.push(itinerary.stops[end].stop_name)
        return stops;
    }
    return null;
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
    const relativeLeaveTime = getRelativeTime_(goTime);
    const within15Minutes = (Math.round(goTime - now / 60000)) < 15;

    const parentId = parentEv.id;
    const marker = COMMUTE_TAG_PREFIX + parentId;

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
    const body = {
        summary,
        description: dedent_
                `
                Bus ${ ((goTime - now > 0) ? "leaves " : "left ") + relativeLeaveTime } at ${ toRelativeTime_(relevantBusTimes[0]) }
                 ➟ Last updated at ${ toRelativeTime_(now) }
                 
                Get on at:   ${ (relevantBusStops[0] || parentEv.summary || "unknown stop | stay vigilant!") + " @ " + toRelativeTime_(relevantBusTimes[0]) }
                Get off at:   ${ (relevantBusStops[1] || parentEv.summary || "unknown stop | stay vigilant!") + " @ " + toRelativeTime_(relevantBusTimes[1])}

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
