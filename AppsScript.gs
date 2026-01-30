const need_transit_threshold_minutes = 90;
const COMMUTE_TAG_PREFIX = "auto_commute_parent=";

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
        now.getTime() - minsToMs(need_transit_threshold_minutes),
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

        const depart = new Date(itinerary.start_time * 1000);
        const arrive = new Date(itinerary.end_time * 1000);
        const busNumber = getBusNumber_(itinerary);
        // Create a buffer ending at the meeting start; if routing arrives earlier, you can pad later.
        upsertCommuteEvent_(targetCalendar, ev, depart, arrive, busNumber);
        Utilities.sleep(10000); // I think transitAPI rate limit is 6 calls per minute -> 10s per call
    }
}

function shouldProcess_(ev, allEvents, targetCalendar, now, eventStart) {
    const timeUntilEvent = eventStart.getTime() - now.getTime();
    const thresholdStart = new Date(
        eventStart.getTime() - minsToMs(need_transit_threshold_minutes),
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

    // Check if event is within 60 minutes -- 'realtime' updating
    if (timeUntilEvent <= minsToMs(60) && timeUntilEvent > 0) {
        return true;
    }

    // Check if there is NOT an entry in targetCalendar (AutoTransit) in the past 60 minutes
    // * from the event start time
    const targetThresholdStart = new Date(eventStart.getTime() - minsToMs(60));
    const recentTargetEvents =
        Calendar.Events.list(targetCalendar, {
            timeMin: targetThresholdStart.toISOString(),
            timeMax: eventStart.toISOString(),
            singleEvents: true,
            maxResults: 250,
        }).items || [];

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

function upsertCommuteEvent_(calId, parentEv, depart, arrive, busNumber) {
    const parentId = parentEv.id;
    const marker = COMMUTE_TAG_PREFIX + parentId;

    // Find existing commute event in a small window
    const searchMin = new Date(depart.getTime() - 6 * 60 * 60 * 1000);
    const searchMax = new Date(arrive.getTime() + 6 * 60 * 60 * 1000);

    const existing =
        Calendar.Events.list(calId, {
            timeMin: searchMin.toISOString(),
            timeMax: searchMax.toISOString(),
            q: marker,
            singleEvents: true,
            maxResults: 10,
        }).items || [];

    const summary = `🚍 ${busNumber || "Bus"} to: ${parentEv.summary || "(untitled)"}`;
    const body = {
        summary,
        description:
            `Auto-generated by AutoTransit for:\n${parentEv.summary || "Name"} at ${parentEv.location || "Location"}\n\n${marker}`.trim(),
        start: { dateTime: depart.toISOString() },
        end: { dateTime: arrive.toISOString() },
    };

    if (existing.length) {
      console.log("updating: ", summary);
        Calendar.Events.patch(body, calId, existing[0].id);
    } else {
        console.log("creating: ", summary);
        Calendar.Events.insert(body, calId);
    }
}

function otpDateTime_(d) {
    // OTP commonly accepts date=YYYY-MM-DD and time=HH:MMam/pm
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());

    let h = d.getHours();
    const m = pad(d.getMinutes());
    const ampm = h >= 12 ? "pm" : "am";
    h = h % 12;
    if (h === 0) h = 12;

    return { dateStr: `${yyyy}-${mm}-${dd}`, timeStr: `${h}:${m}${ampm}` };
}

function toQuery_(obj) {
    return Object.keys(obj)
        .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]))
        .join("&");
}

function minsToMs(mins) {
    return mins * 60 * 1000;
}
