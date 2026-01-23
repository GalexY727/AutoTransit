const OPT_IN_TAG = "#commute";
const COMMUTE_TAG_PREFIX = "auto_commute_parent=";

function runPlanner() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty("TRANSIT_API_KEY");
  const homeAddress = props.getProperty("HOME_ADDRESS");
  const targetCalendar = props.getProperty("TARGET_CALENDAR_ID") || "primary";
  const sourceCalendar = props.getProperty("SOURCE_CALENDAR_ID") || "UCSC Classes";
  if (!apiKey || !homeAddress) throw new Error("Missing TRANSIT_API_KEY or HOME_ADDRESS");

  const now = new Date();
  const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000); // next 24h

  // Pull events in the next 24 hours
  const events = Calendar.Events.list(sourceCalendar, {
    timeMin: now.toISOString(),
    timeMax: horizon.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250
  }).items || [];

  // Pre-geocode home once
  const homeLL = geocodeOrThrow_(homeAddress);

  for (const ev of events.slice(0,3)) {
    // if (!shouldProcess_(ev)) continue; // TODO: Implement
    if (!ev.start || !ev.start.dateTime) continue; // skip all-day
    if (!ev.location) continue; // nowhere to route to

    const eventStart = new Date(ev.start.dateTime);
    const destLL = geocodeOrThrow_(ev.location);

    const plan = transitPlanArriveBy_(apiKey, homeLL, destLL, eventStart);
    const itinerary = pickBestItinerary_(plan, eventStart);
    if (!itinerary) continue;

    const depart = new Date(itinerary.start_time * 1000);
    const arrive = new Date(itinerary.end_time * 1000);
    const busNumber = getBusNumber_(itinerary);
    // Create a buffer ending at the meeting start; if routing arrives earlier, you can pad later.
    upsertCommuteEvent_(targetCalendar, ev, depart, arrive, busNumber);
  }
}

function shouldProcess_(ev) {
  const hay = (ev.description || "") + " " + (ev.summary || "");
  return hay.includes(OPT_IN_TAG);
}

// Uses Apps Script Maps service geocoder
function geocodeOrThrow_(address) {
  const res = Maps.newGeocoder().geocode(address);
  if (!res || res.status !== "OK" || !res.results || !res.results.length) {
    throw new Error("Failed to geocode: " + address + " status=" + (res && res.status));
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
    consider_downtime: true
  };

  const url = "https://external.transitapp.com/v3/public/plan?" + toQuery_(qs);
  const resp = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { apiKey: apiKey },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 300) {
    throw new Error("Transit plan failed: " + resp.getResponseCode() + " " + resp.getContentText());
  }
  return JSON.parse(resp.getContentText());
}

function pickBestItinerary_(plan, eventStart) {
  const itineraries = plan?.results || [];
  const idealTime = eventStart.setMinutes(eventStart.getMinutes() - 10);
  let bestResult = itineraries[0]; 
  
  for (const result of itineraries.slice(1)) {
    const time = result?.end_time;
    if (!time) continue;
    
    const diff = Math.abs(idealTime - time) 
    if (diff < Math.abs(idealTime - bestResult.endTime)) {
      bestResult = result;
    }
  }
  return bestResult || null;
  // Simple heuristic: first itinerary is often best; you can refine (fewest transfers, etc.)
  return itineraries[0] || null;
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

  const existing = Calendar.Events.list(calId, {
    timeMin: searchMin.toISOString(),
    timeMax: searchMax.toISOString(),
    q: marker,
    singleEvents: true,
    maxResults: 10
  }).items || [];

  const summary = `🚍 ${busNumber || "Bus"} to: ${parentEv.summary || "(untitled)"}`;
  const body = {
    summary,
    description: `${marker}\n\nAuto-generated travel buffer for:\n${parentEv.htmlLink || ""}`.trim(),
    start: { dateTime: depart.toISOString() },
    end: { dateTime: arrive.toISOString() }
  };

  if (existing.length) {
    Calendar.Events.patch(body, calId, existing[0].id);
  } else {
    console.log('creating');
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
  h = h % 12; if (h === 0) h = 12;

  return { dateStr: `${yyyy}-${mm}-${dd}`, timeStr: `${h}:${m}${ampm}` };
}

function toQuery_(obj) {
  return Object.keys(obj)
    .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]))
    .join("&");
}