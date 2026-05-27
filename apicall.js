const fs = require("fs/promises");
require("dotenv").config();

async function main() {
  const url = new URL("https://external.transitapp.com/v4/public/plan");
  const params = {
    from_lat: "36.9683327",
    from_lon: "-122.0572228",
    to_lat: "37.0003748",
    to_lon: "-122.0631966",
    arrival_time: "1779848640",
    should_update_realtime: "true",
    consider_downtimes: "true",
    max_num_departures: "3", // fetch the next departure so we can surface it after the bus leaves
    num_result: "3",
    max_num_legs: "3",
    walk_reluctance: "1.1",
    walk_speed: "0.89",
    should_include_directions: "true",
    walk_fallback: "true"
  };

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  console.log(url.toString());

  const response = await fetch(url, {
    headers: {
      apiKey: process.env.TRANSIT_API_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(`Transit API error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  console.log(response.status);
  await fs.writeFile("v4-public-plan-return", JSON.stringify(data, null, 2) + "\n");
  console.log("Wrote response to v4-public-plan-return");
}

main().catch(console.error);
