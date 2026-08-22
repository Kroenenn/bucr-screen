# bucr-screen

A departure-board kiosk screen for one bUCR stop. Built to run unattended on
a Raspberry Pi 5 wired to a display — designed for the Facultad de Educación
event, but the target stop is config, not hardcoded, so it's reusable.

See [PLAN.md](./PLAN.md) for the full design rationale, research notes, and
implementation checklist — read that first if you're changing how data
flows, not just tweaking the UI.

## How it works

Three operation modes, picked at deploy time via `NUXT_OPERATION_MODE`:

- **`real`** — polls Databús's GTFS-RT `trip_updates.json` feed directly
  (plain HTTP, no WebSocket — Databús doesn't expose one for this; there's
  no separate server-side poll loop either, each `/api/arrivals` request
  fetches fresh, so the effective poll cadence is
  `NUXT_PUBLIC_REFRESH_INTERVAL_SECONDS`), and derives arrivals for the
  configured stop. If the feed is unreachable, stale, or has nothing for
  this stop, it **automatically falls back** to the GTFS schedule for that
  response and keeps retrying in the background — this fallback is what
  makes `real` mode safe to leave running unattended.
- **`fake`** — GTFS schedule only, always. Never calls Databús. "Next
  departure" computed as `scheduled_time - now`, using the static feed at
  `NUXT_GTFS_FEED_URL`, honoring `calendar.txt`/`calendar_dates.txt` (so it
  correctly shows nothing outside real service hours/days).
- **`demo`** — a synthetic departure sequence for previewing/testing the
  board without waiting out bUCR's real ~20-35 minute gaps. Real
  destinations and the route id come from the stop's richest service
  pattern in the actual GTFS data; the *timing* is a fixed, dense pattern
  (3-5 minute gaps, real-time paced — no acceleration) chosen so a viewer
  sees the full lifecycle within minutes: counting down, "PRÓXIMO", the
  moment it departs, a "SALIENDO" state with a pulsing dot, removal from
  the list (with the remaining rows sliding smoothly into place), then the
  next one already visible. Visually distinguished with a blue "DEMO" badge
  (never amber, so it can't be mistaken for real live data).

  The "SALIENDO" state is **demo-only** — `real` and `fake` remove a trip
  the instant it departs, matching
  [MBTA's own Real-Time Display Guidelines](https://www.mbta.com/developers/real-time-display-guidelines),
  which say a prediction should stop being shown entirely once it goes
  negative ("the vehicle has already left the stop"). Showing a bus that's
  actually gone as "departing" would misinform a real rider; showing it
  briefly in a demo makes an otherwise-instant, easy-to-miss transition
  visible to someone watching the demo. See PLAN.md for the full reasoning
  and other sources checked.

All three modes share the same static-GTFS layer (stop name, trip
headsigns, schedule computation) — `real` mode is "live data with the
schedule as a safety net," not an unrelated code path, and `demo` reuses
the same GTFS parsing for realistic destinations.

All three also share a `NUXT_STOP_DIRECTION_ID` filter: bUCR_0_01
(Educación) is a two-way terminus, so it has stop_times for trips that
*end* there too (direction 1, trip_headsign "Educación" itself) alongside
the ones that actually depart from there (direction 0, to "Odontología").
Without filtering by direction, the board would show "Educación" as a
destination — confusing at best ("a bus to Educación, boarding at
Educación?"), and just wrong: that stop_time is a bus arriving to go out of
service, not something a waiting rider can catch. See `.env.example` and
PLAN.md for how this was found and fixed.

Some Educación→Odontología departures take the longer "milla
universitaria" loop instead of the direct route (bUCR's own `..._con_milla_...`
vs `..._sin_milla_...` trip_ids) — same destination headsign either way, so
without a marker they'd be indistinguishable. A small "con milla" badge
next to the headsign (`ArrivalRow.vue`) flags these, matching the badge
infobus-web already uses for the same signal.


## Theme toggle

A sun/moon button above the clock (top-right) switches between the dark
kiosk theme (default) and a light one — `app/composables/useKioskTheme.ts`.
Resets to dark on every reload/reboot by design, same reasoning as
infobus-web's kiosk pages: a display power-cycling mid-event should always
come back in its normal state, not whatever a previous visitor left it on.

## Requirements

- Node.js 22+
- Docker + Docker Compose, for the deployment path

## Development

```bash
npm install
cp .env.example .env   # adjust NUXT_OPERATION_MODE, NUXT_STOP_ID, etc.
npm run dev
```

Open <http://localhost:3000>.

```bash
npm test          # Vitest — schedule-mode, realtime-mode, demo-mode logic
npm run typecheck # vue-tsc
npm run build     # production build into .output/
```

To run the production build directly (without Docker):

```bash
npm run build
NUXT_OPERATION_MODE=fake node .output/server/index.mjs
```

### Testing `real` mode locally without a live event

Databús's `main` branch doesn't ship realistic-looking live data by default.
[`databus-sim`](https://github.com/simovilab/databus-sim) ("simbus") is a
deterministic GTFS-based bus movement simulator that publishes MQTT
telemetry into a running Databús stack, which Databús then turns into a real
`trip_updates.json` feed — that's the easiest way to exercise `real` mode
end-to-end without a physical vehicle. See that repo's README for how to
point it at a Databús dev instance.

## Configuration

All variables are documented in [`.env.example`](./.env.example). They use
Nuxt's `NUXT_<KEY>` runtime-config convention, which means they're read at
**container start time** — flipping `NUXT_OPERATION_MODE` or changing
`NUXT_STOP_ID` only needs a restart, not a rebuild.

| Variable | Default | Purpose |
|---|---|---|
| `NUXT_OPERATION_MODE` | `real` | `real`, `fake`, or `demo` |
| `NUXT_STOP_ID` | `bUCR_0_01` | GTFS `stop_id` to display (`bUCR_0_01` = Educación) |
| `NUXT_STOP_DIRECTION_ID` | `0` | Which `direction_id` actually departs from `NUXT_STOP_ID` — change alongside it |
| `NUXT_GTFS_FEED_URL` | `feeds.simovi.org/bucr/schedule/gtfs.zip` | Static GTFS Schedule |
| `NUXT_GTFS_REFRESH_INTERVAL_SECONDS` | `21600` | How often to re-fetch the static feed |
| `NUXT_DATABUS_BASE_URL` | `https://databus.bucr.digital` | Databús base URL — **verify this before the event**, see PLAN.md |
| `NUXT_REALTIME_STALE_THRESHOLD_SECONDS` | `90` | Feed age (or emptiness) beyond which `real` mode falls back |
| `NUXT_REALTIME_FETCH_TIMEOUT_MS` | `5000` | Per-request timeout against Databús |
| `NUXT_DEMO_DEPARTING_GRACE_SECONDS` | `180` | How long a departed trip shows "SALIENDO" in `demo` mode before removal |
| `NUXT_PUBLIC_REFRESH_INTERVAL_SECONDS` | `15` | How often the kiosk page polls `/api/arrivals` (all modes — demo runs at normal pace, no separate interval needed) |
| `NUXT_PUBLIC_MAX_ARRIVALS` | `5` | Max rows shown on screen |
| `HOST_PORT` | `3000` | docker-compose only — host-side port |

## Deployment

```bash
cp .env.example .env   # adjust for the event
docker compose up -d --build
```

For the actual Raspberry Pi kiosk setup (Chromium in kiosk mode, autostart
on boot, screen-blanking disabled), see
[`deploy/raspberry-pi/README.md`](./deploy/raspberry-pi/README.md).

## Project layout

```
app/                  Nuxt frontend (srcDir) — the kiosk screen
  pages/index.vue      the only route
  components/          ModeBadge, ArrivalRow, ThemeToggle
  composables/         useKioskClock, useKioskTheme, useArrivals
  assets/css/          brand tokens, dark + light kiosk themes
server/                Nitro backend
  api/arrivals.get.ts   orchestrates mode selection + fallback
  utils/gtfs.ts          static GTFS fetch/parse/cache
  utils/schedule-mode.ts "fake" mode + real-mode fallback
  utils/realtime-mode.ts "real" mode (Databús polling)
  utils/demo-mode.ts     "demo" mode (synthetic dense departure sequence)
  utils/time.ts           Costa Rica local-time helpers
shared/types.ts        types shared between app/ and server/
tests/                 Vitest — schedule-mode, realtime-mode, demo-mode
deploy/raspberry-pi/   Pi-specific kiosk setup docs + systemd units
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
