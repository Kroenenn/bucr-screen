# bucr-screen

A departure-board kiosk screen for one bUCR stop, built to run unattended on
a Raspberry Pi 5 wired to a display. The target stop is configuration, not
hardcoded.

## Requirements

- Node.js 22+
- [pnpm](https://pnpm.io/) 10.x (`corepack enable` picks up the version
  pinned in `package.json`)
- Docker + Docker Compose, for the deployment path

## Development

```bash
pnpm install
cp .env.example .env
pnpm dev                # http://localhost:3000
```

```bash
pnpm test               # Vitest
pnpm run lint           # ESLint
pnpm run typecheck      # vue-tsc
pnpm run build          # production build into .output/
```

Run the production build without Docker:

```bash
pnpm run build
NUXT_OPERATION_MODE=fake node .output/server/index.mjs
```

## How it works

The server exposes `/api/arrivals`; the kiosk page polls it and renders the
next departures. Three operation modes, selected with `NUXT_OPERATION_MODE`:

| Mode | Source |
|---|---|
| `fake` *(default)* | GTFS schedule only. Never contacts Databús. |
| `real` | Polls Databús's GTFS-RT `trip_updates.json` over HTTP, and falls back to the schedule whenever that feed is unreachable, stale, or empty. |
| `demo` | Replays the stop's real schedule — real gaps, destinations and `con milla` flags — compressed into `NUXT_DEMO_CYCLE_SECONDS` of real time. Marked on screen with a blue `DEMO` badge. |

All three share the same static-GTFS layer (stop name, headsigns, schedule
computation, branding).

**`fake` is the default** so a fresh checkout or an unconfigured deployment
never depends on a reachable Databús. Switch to `real` once
`NUXT_DATABUS_BASE_URL` points at a live feed.

### Terminus departure prediction

At a plain mid-route stop, `real` mode's predictions are the ordinary
GTFS-RT case: read the trip's own `trip_updates` arrival at that stop.

A *departure terminus* like Educación (`bUCR_0_01`) is different: the
outbound trip (`direction_id=0`, →Odontología) only produces GTFS-RT once its
run is `in_progress`, which requires the bus to already be moving away from
the stop — i.e. exactly in the window a waiting rider wants a prediction,
there is no realtime for that trip yet, only the static timetable (which
drifts, since a driver can't start the next run until physically back at the
terminus).

Setting `NUXT_TERMINUS_PREDICTION=true` closes that gap by chaining runs: the
same physical bus is very likely already visible on the *inbound* feeder trip
(`direction_id=1`, terminal stop `bUCR_0_01`) that is driving toward the
terminus to become that outbound trip. That inbound run **is** `in_progress`
and telemetering, so its `trip_updates` entry carries a real,
position-anchored predicted arrival time at the terminus (Databús does the
map-matching and delay propagation server-side; the board just reads
`arrival.time`). The board matches each upcoming scheduled outbound slot to
the nearest plausible inbound arrival (within
`NUXT_TERMINUS_MAX_EARLY_SECONDS` / `NUXT_TERMINUS_MAX_LAYOVER_SECONDS` of the
slot's scheduled time) and shows:

```
estimated_departure = max(scheduled_departure, predicted_arrival + NUXT_TERMINUS_BOARDING_BUFFER_SECONDS)
```

— i.e. the displayed departure is **never earlier than the timetable**; a
late feeder bus pushes the shown time out, an on-time or early one just shows
the scheduled time. A slot with no matched inbound arrival (a pull-out with
no feeder, or one beyond the feed's horizon) keeps its plain scheduled time,
exactly like today.

Only active when `NUXT_OPERATION_MODE=real`, `NUXT_TERMINUS_PREDICTION=true`,
and `NUXT_STOP_ID` is itself a departure terminus (a trip's first boardable
stop *and* another trip's terminal stop). See
[`design/realtime-terminus-prediction.md`](./design/realtime-terminus-prediction.md)
for the full design.

**Honest caveat:** this only helps when inbound feeder runs are actually
dispatched and telemetering. If the real deployment doesn't start every
inbound run (dispatcher "begin run" + the vehicle sending position pings),
`runs:in_progress` is empty for those trips, no inbound prediction exists to
match against, and the board correctly falls back to the same (drifting)
schedule it shows today. This is an operational precondition, not something
the screen code can fix on its own.

### Boardable departures

A stop_time is shown only if it's a real boarding opportunity: not the trip's
last `stop_sequence`, and not `pickup_type=1`. This matters at two-way
termini like Educación (`bUCR_0_01`), which also has stop_times for trips
that *end* there. It's inferred from `stop_times.txt`, so pointing
`NUXT_STOP_ID` at another stop needs no extra configuration.

### "con milla" badge

Some Educación→Odontología departures take the longer *milla universitaria*
loop (`..._con_milla_...` vs `..._sin_milla_...` trip ids) but carry the same
headsign. `ArrivalRow.vue` badges those, matching infobus-web.

### Branding

Route name, footer text and agency attribution come from `routes.txt` and
`agency.txt` at request time (`brandingMeta` in `server/api/arrivals.get.ts`),
so they follow the feed without a redeploy. The bUCR logo and favicon are
static assets in `public/`.

### Theme

A sun/moon button toggles dark (default) and light. The choice is not
persisted, so a display that power-cycles always comes back dark.

## Configuration

Variables use Nuxt's `NUXT_<KEY>` runtime-config convention and are read at
**container start**, so changing one needs a restart, not a rebuild. Each is
documented in [`.env.example`](./.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `NUXT_OPERATION_MODE` | `fake` | `real`, `fake`, or `demo` |
| `NUXT_STOP_ID` | `bUCR_0_01` | GTFS `stop_id` to display (Educación) |
| `NUXT_GTFS_FEED_URL` | `feeds.simovi.org/bucr/schedule/gtfs.zip` | Static GTFS Schedule |
| `NUXT_GTFS_REFRESH_INTERVAL_SECONDS` | `21600` | Feed refresh window (refreshes in the background; never blocks a request) |
| `NUXT_GTFS_FETCH_TIMEOUT_MS` | `15000` | Deadline for the feed download |
| `NUXT_DATABUS_BASE_URL` | `https://databus.bucr.digital` | Databús base URL. **Does not currently resolve** — confirm before using `real`. The app appends `/feed/realtime/trip_updates.json` (used for both plain realtime arrivals and, as shipped, terminus prediction — `vehicle_positions.json` is not fetched in v1). The validated live host as of this writing is `https://app.167.233.130.36.sslip.io`; confirm it's still current, and whether a stable DNS name has replaced this IP-encoded sslip.io host, before production use. |
| `NUXT_REALTIME_STALE_THRESHOLD_SECONDS` | `90` | Feed age (or emptiness) beyond which `real` falls back |
| `NUXT_REALTIME_FETCH_TIMEOUT_MS` | `5000` | Per-request timeout against Databús |
| `NUXT_TERMINUS_PREDICTION` | `false` | Opt-in: at a departure terminus, estimate departures from the inbound feeder run's real-time predicted arrival instead of the static schedule alone. Only takes effect in `real` mode, and only when `NUXT_STOP_ID` is itself a departure terminus. See "How it works" below. |
| `NUXT_TERMINUS_BOARDING_BUFFER_SECONDS` | `60` | Fixed buffer added to a matched inbound feeder's predicted terminus arrival before it counts as the estimated departure |
| `NUXT_TERMINUS_MAX_LAYOVER_SECONDS` | `1200` | Upper bound on how much later than a slot's scheduled time a candidate feeder's predicted arrival may be and still match that slot |
| `NUXT_TERMINUS_MAX_EARLY_SECONDS` | `300` | Upper bound on how much earlier than a slot's scheduled time a candidate feeder's predicted arrival may be and still match that slot |
| `NUXT_DEMO_CYCLE_SECONDS` | `900` | Real seconds for one full compressed replay |
| `NUXT_DEMO_DEPARTING_GRACE_SECONDS` | `180` | How long a departed trip shows `SALIENDO` in `demo` (schedule-equivalent seconds) |
| `NUXT_PUBLIC_REFRESH_INTERVAL_SECONDS` | `15` | Page poll interval in `real`/`fake` |
| `NUXT_PUBLIC_DEMO_REFRESH_INTERVAL_SECONDS` | `3` | Page poll interval in `demo` |
| `NUXT_PUBLIC_MAX_ARRIVALS` | `4` | Max rows on screen |
| `HOST_PORT` | `3000` | `compose.yml` only — host-side port |

### Exercising `real` mode locally

[`databus-sim`](https://github.com/simovilab/databus-sim) publishes MQTT
telemetry into a running Databús stack, which Databús turns into a real
`trip_updates.json`. See that repo for pointing it at a dev instance.

## Deployment

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps          # STATUS should reach "healthy"
```

`compose.yml` is tuned for unattended operation: a healthcheck against
`/api/health` (which never contacts Databús, so a feed outage can't trigger a
restart loop), capped logs so a long run can't fill the microSD card, and
`no-new-privileges`.

Raspberry Pi kiosk setup (Chromium kiosk mode, autostart, screen blanking) is
in [`deploy/raspberry-pi/README.md`](./deploy/raspberry-pi/README.md).

## Project layout

```
app/                     Nuxt frontend (srcDir)
  pages/index.vue          the only route
  components/              ModeBadge, ArrivalRow, ThemeToggle
  composables/             useKioskClock, useKioskTheme, useArrivals
  assets/css/              theme tokens, dark + light
server/                  Nitro backend
  api/arrivals.get.ts      mode selection + fallback
  api/health.get.ts        liveness probe for the healthcheck
  plugins/gtfs-warmup.ts   loads the feed at boot
  utils/gtfs.ts            GTFS fetch/parse/cache
  utils/schedule-mode.ts   "fake" mode + real-mode fallback
  utils/realtime-mode.ts   "real" mode (Databús polling)
  utils/demo-mode.ts       "demo" mode
  utils/time.ts            agency_timezone-driven local-time helpers
shared/types.ts          types shared between app/ and server/
public/                  logo + favicon
tests/                   Vitest
deploy/raspberry-pi/     kiosk setup docs + systemd units
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
