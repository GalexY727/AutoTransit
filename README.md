# AutoTransit

AutoTransit is a Google Apps Script project that plans transit trips for upcoming Google Calendar events and writes the commute details back to a target calendar.

It uses your home address, event locations, the Google Calendar advanced service, and the Transit API to create or update bus events with departure times, stop names, transfers, crowding levels, and next-departure information.

## Features

- **Automatic commute events**: creates or updates calendar entries for upcoming events that need transit from home.
- **Transit API v4 planning**: plans trips with real-time updates, downtime handling, and an extra departure for next-bus guidance.
- **Multi-leg route support**: combines normal transfers into one commute event and lists each leg with route, stop, and transfer wait details.
- **Split transfer support**: if a two-leg trip has a transfer of 15 minutes or more, AutoTransit creates separate calendar events for each leg.
- **Crowding levels**: adds crowding status for bus legs when vehicle occupancy data is available.
- **Late-bus context**: after a planned bus leaves, descriptions can show the next departure when the API provides one.
- **Safer event filtering**: skips all-day and malformed events, ignores non-timed commute matches, and avoids unnecessary API calls.
- **Run summaries**: logs each created, updated, or deleted event, then logs the total number of changes made by `runPlanner()`.
- **Local test suite**: Node-based tests cover the pure helpers and cleanup behavior. Not pushed to clasp.

## How It Works

1. `runPlanner()` reads script properties for your API key, home address, source calendar, and target calendar.
2. It scans upcoming source-calendar events within the planning window.
3. It skips events that do not need a commute, such as all-day events, events without locations, and events soon after another source event.
4. It geocodes your home address and the event location.
5. It requests a Transit API plan that arrives before the event.
6. It picks the itinerary closest to arriving 10 minutes early.
7. It fetches crowding data for bus legs when route IDs are available.
8. It creates, updates, or deletes target-calendar commute events as needed.
9. It logs each calendar change and a final change count.

## Requirements

- A Google account with Google Calendar access.
- A Google Apps Script project using the V8 runtime.
- The Google Calendar advanced service enabled in Apps Script.
- A Transit API key.
- Node.js and npm for local development.

## Script Properties

Set these in Apps Script under **Project Settings > Script properties**:

| Property | Required | Description |
| --- | --- | --- |
| `TRANSIT_API_KEY` | Yes | API key for `external.transitapp.com`. |
| `HOME_ADDRESS` | Yes | Starting address for commute planning. |
| `SOURCE_CALENDAR_ID` | No | Calendar to scan for destination events. Defaults to `UCSC Classes`. |
| `TARGET_CALENDAR_ID` | No | Calendar where commute events are written. Defaults to `AutoTransit`. |

AutoTransit also manages these internal properties automatically:

| Property | Purpose |
| --- | --- |
| `LAST_HOME_ADDRESS_DO_NOT_MANUALLY_MODIFY` | Detects when `HOME_ADDRESS` changes. |
| `HOME_LL_DO_NOT_MANUALLY_MODIFY` | Cached home latitude/longitude. |
| `CLEANUP_PAST_COMMUTE_TITLES_PAGE_TOKEN_DO_NOT_MANUALLY_MODIFY` | Resume token for batched cleanup runs. |

You normally do not need to set or edit the internal properties.

## Installation

1. Install clasp locally as a development dependency:

   ```bash
   npm install --save-dev @google/clasp
   ```

   This keeps clasp isolated to this project instead of installing it globally.

2. Log in to clasp if you have not already:

   ```bash
   npm run clasp -- login
   ```

3. Create or connect an Apps Script project.

   To use the existing `.clasp.json`, make sure it points at the correct `scriptId`. To connect a different script, update `.clasp.json` or run the clasp command you normally use for your project setup.

4. Enable the Calendar advanced service.

   The repo includes `appsscript.json` with the Calendar v3 advanced service configured. In the Apps Script editor, also confirm **Services > Calendar API** is enabled for the project.

5. Set the script properties listed above.

6. Push the project:

   ```bash
   npm run push
   ```

   The `tests/**` directory is ignored by clasp via `.claspignore`, so local tests are not uploaded to Apps Script.

7. In Apps Script, create a trigger for `runPlanner`.

   A time-driven trigger is usually the safest option. Calendar-change triggers can work, but be careful with recursion because AutoTransit writes calendar events too.

## Local Development

Run the test suite:

```bash
npm test
```

Check JavaScript syntax:

```bash
node --check Code.js
```

Useful npm scripts:

| Command | Description |
| --- | --- |
| `npm test` | Runs `tests/test-suite.js`. |
| `npm run push` | Pushes the Apps Script project with clasp. |

## Operational Helpers

### `runPlanner()`

Main entry point. This is the function to schedule with an Apps Script trigger.

When it changes calendar events, it logs messages like:

```text
Made 18 to CSE 101 on Jan 2, 2026
Updated 19 to Science Hill on Jan 3, 2026
Deleted 20 to Old commute on Jan 4, 2026
AutoTransit made 3 changes.
```

## Notes

- AutoTransit sleeps between Transit API calls to respect rate limits.
- The script only plans for timed events with locations.
- Stop-name fallbacks use the parent event summary when the API does not provide stop data.
- Two-leg trips with transfer waits at or above 15 minutes are split into separate events.
- Three-or-more-leg trips stay combined.

## License

This project is licensed under the GNU GPLv3 License. See [LICENSE](LICENSE).
