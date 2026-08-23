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

**`fake` is the default because `real` has nothing to show today**: Databús
has no implemented path for a run to reach `runs:in_progress`, so its feed is
always empty. Beyond that, real-time predictions add little at a *departure
terminus* like Educación — a trip that hasn't started has no vehicle
telemetry, and an observed bus can't be matched to a scheduled trip from
position alone (bUCR's `trips.txt` has no `block_id`). Switch to `real` when
there is a reachable Databús and the board points at a mid-route stop.

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
| `NUXT_DATABUS_BASE_URL` | `https://databus.bucr.digital` | Databús base URL. **Does not currently resolve** — confirm before using `real`. The app appends `/feed/realtime/trip_updates.json`. |
| `NUXT_REALTIME_STALE_THRESHOLD_SECONDS` | `90` | Feed age (or emptiness) beyond which `real` falls back |
| `NUXT_REALTIME_FETCH_TIMEOUT_MS` | `5000` | Per-request timeout against Databús |
| `NUXT_DEMO_CYCLE_SECONDS` | `900` | Real seconds for one full compressed replay |
| `NUXT_DEMO_DEPARTING_GRACE_SECONDS` | `180` | How long a departed trip shows `SALIENDO` in `demo` (schedule-equivalent seconds) |
| `NUXT_PUBLIC_REFRESH_INTERVAL_SECONDS` | `15` | Page poll interval in `real`/`fake` |
| `NUXT_PUBLIC_DEMO_REFRESH_INTERVAL_SECONDS` | `3` | Page poll interval in `demo` |
| `NUXT_PUBLIC_MAX_ARRIVALS` | `5` | Max rows on screen |
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
