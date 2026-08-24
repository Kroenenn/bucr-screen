# Plan: real-time departure prediction at a terminus (Educación)

**Status:** design / agent brief — not yet implemented
**Author context:** written for later orchestration by Sonnet implementation agents. Everything an agent needs to build this without the original investigation context is inlined here.
**Target file to point the board at:** `NUXT_STOP_ID=bUCR_0_01` (Educación), a **departure terminus**.

---

## 1. The problem

Educación is a **departure terminus**: outbound trips (`desde_educacion_a_odontologia_*`, `direction_id=0`, headsign *Odontología*) *start* there. In the Databús run model, a run only produces GTFS-RT once it is `runs:in_progress`, which requires (a) a dispatcher "begin run" **and** (b) the vehicle telemetering a `position` ping with `speed > 0.5 m/s`. Both happen only once the bus is physically at Educación and pulling out.

Consequence: in exactly the window where a waiting rider wants a prediction — *before* the bus leaves — there is **no realtime for the outbound trip**, and the static timetable is all we have. The timetable drifts from reality by minutes (a driver can't start the next run until they physically arrive at Educación finishing their previous run), and the board has no way to know how late it is.

### The idea (validated)

The *same physical bus* is arriving at Educación on an **inbound** run (`desde_odontologia_a_educacion_*` or the single evening `desde_edufi_a_educacion_*`, `direction_id=1`, headsign *Educación*, whose **terminal stop is `bUCR_0_01`**). That inbound run **is** `in_progress` and telemetering while it drives toward Educación. So:

1. Predict when the inbound bus will reach Educación (`bUCR_0_01`).
2. Treat that bus as the next departure from Educación.
3. Show **`estimated_departure = max(scheduled_departure, predicted_arrival + BOARDING_BUFFER)`** — never earlier than the timetable; if the feeder bus is late, push the departure out to when it will actually arrive and board.

This is interline / block chaining. It is correct for a terminus and is the right lever here.

---

## 2. Databús realtime reality (verified against the LIVE production feed, 2026-08-24)

Live feed base URL (confirmed reachable): **`https://app.167.233.130.36.sslip.io`**
- `GET /feed/realtime/trip_updates.json`
- `GET /feed/realtime/vehicle_positions.json`

The current app already uses this exact path shape (`/feed/realtime/trip_updates.json`); only `NUXT_DATABUS_BASE_URL` needs pointing at the host above (the previous `https://databus.bucr.digital` placeholder does not resolve). Real captured samples are committed at `design/feed-samples/*.sample.json` — use them as test fixtures.

> **Correction to earlier notes / the Databús docs:** the docs site (`databus.simovilab.org`) describes a `fake_stop_times` module producing *synthetic random* stop-time offsets. **That is outdated.** The live production feed produces **real, position-derived predictions** — see §2.1. Ignore the "fake stop times" description.

### 2.1 `trip_updates` carries REAL per-stop arrival predictions — this is the primary source

Verified from the live feed. Each in-progress run is one entity keyed by `vehicle_id`, with a `trip_update.stop_time_update[]` of predicted `arrival`/`departure` times for the trip's remaining stops:

```jsonc
{ "id": "299-922",
  "trip_update": {
    "timestamp": 1787591012,
    "trip": { "trip_id": "desde_educacion_a_odontologia_sin_milla_entresemana_10:45",
              "route_id": "bUCR", "direction_id": 0, "schedule_relationship": "SCHEDULED" },
    "vehicle": { "id": "299-922", "label": "299-922", "license_plate": "299-922" },
    "stop_time_update": [
      { "stop_sequence": 1, "stop_id": "bUCR_0_05",
        "arrival":   { "time": 1787591075, "uncertainty": 120 },
        "departure": { "time": 1787591075, "uncertainty": 120 } },
      { "stop_sequence": 2, "stop_id": "bUCR_0_06", "arrival": { "time": 1787591128, ... } },
      // … non-contiguous seq (…,5,7,8) …
      { "stop_sequence": 8, "stop_id": "bUCR_0_11", "arrival": { "time": 1787591702, ... } }
    ] } }
```

Why these are genuine predictions (not schedule echoes): in the sample the bus is `IN_TRANSIT_TO` its next stop and the predicted `arrival.time` there is only **~63 s after the position fix** (`timestamp` 1787591012 → arrival 1787591075), consistent with the live GPS position — a static echo would sit at the absolute scheduled clock time instead. The prediction is anchored on the live position, so **lateness is already baked in**: Databús does the map-matching + delay propagation server-side, and we simply consume `arrival.time`.

**Consequence for the terminus problem:** an **inbound** run (`desde_odontologia_a_educacion_*`, terminal stop `bUCR_0_01`) that is in progress appears as an entity whose `stop_time_update[]` ends at `bUCR_0_01` with a **predicted `arrival.time` that reflects the bus's real delay**. That predicted arrival is exactly the number we need. No self-computed propagation required.

Current-shape notes (from the live sample; treat as v1 assumptions, re-check with an inbound sample — §9):
- `arrival.time == departure.time` and `uncertainty` is a flat `120` right now. Use `arrival.time`; carry `uncertainty` through. Prefer `arrival` at the terminal stop; fall back to `departure` if `arrival` is ever absent.
- `stop_sequence` is **non-contiguous** — match the terminal stop by `stop_id == NUXT_STOP_ID` (or by the max stop_sequence present), never by array index.
- `timestamp` is Unix **seconds**.

### 2.2 `vehicle_positions` (secondary — vehicle_id, live status, already-departed detection)

Same 15 s cadence, keyed by `vehicle_id`. Live sample carries: `trip.trip_id/route_id/direction_id`, `position.latitude/longitude/speed/odometer`, `timestamp`, `current_stop_sequence`, `stop_id`, `current_status` (`IN_TRANSIT_TO` in the sample; also `STOPPED_AT` / `INCOMING_AT`). Full field mapping:

| GTFS-RT field | Meaning | Source |
|---|---|---|
| `entity.id` | **vehicle_id** | run's vehicle |
| `vehicle.trip.trip_id` | trip the run is on (matches GTFS Schedule `trip_id` exactly) | `run:<id>:trip` |
| `vehicle.trip.route_id` / `direction_id` / `start_time` / `start_date` | | `run:<id>:trip` |
| `vehicle.vehicle.id` / `label` / `license_plate` | vehicle identity | `vehicle:<id>:metadata` |
| `vehicle.position.latitude` / `longitude` / `bearing` / `speed` | real GPS fix | `vehicle:<id>:position` |
| `vehicle.timestamp` | fix time (Unix **seconds**) | `vehicle:<id>:position` |
| `vehicle.current_stop_sequence` | **map-matched upcoming stop_sequence** | `run:<id>:vehicle_stop_status` |
| `vehicle.stop_id` | map-matched upcoming stop_id | `run:<id>:vehicle_stop_status` |
| `vehicle.current_status` | `STOPPED_AT` \| `INCOMING_AT` \| `IN_TRANSIT_TO` | `run:<id>:vehicle_stop_status` |
| `vehicle.occupancy_status` / `occupancy_percentage` / `congestion_level` | optional | various |

Map-matching (`runs/domain/progression/compute.py`) projects the GPS point onto the trip's GTFS shape polyline (with a forward-monotonic Viterbi assignment that correctly handles loop-back shapes), picks the **nearest stop ahead** as `current_stop_sequence`, and classifies within 20 m + slow ⇒ `STOPPED_AT`, within 50 m + approaching ⇒ `INCOMING_AT`, else `IN_TRANSIT_TO`. A **monotonic guard** prevents the sequence from regressing on GPS jitter.

`current_stop_sequence` values come straight from `stop_times.txt` and **may be non-contiguous** — never assume they increment by 1 (bUCR trips already skip sequence numbers, e.g. an outbound trip goes …,5,7,8).

### 2.3 Run lifecycle facts that bound the prediction window

- Run reaches `In Progress` (⇒ appears in `runs:in_progress` ⇒ appears in `vehicle_positions`) when, while `Tracking`, a `position` ping with `speed > 0.5 m/s` arrives (`RunStartedDetector`).
- Run leaves `in_progress` when it stops at its terminal stop (`RunCompletedDetector`: `current_status=STOPPED_AT` at terminal ⇒ `run_completed`). So an inbound run drops out of the feed **shortly after the bus halts at Educación** — there is a clean window where it is `INCOMING_AT`/`IN_TRANSIT_TO` the last legs and we can predict.
- Silence > 60 s ⇒ `No Signal` (drops from tracking); > 600 s ⇒ `Cancelled`.
- Dispatcher (the user) starts every run via the simulator, so inbound runs **will** be present and telemetering during testing and at the real event.

---

## 3. Chosen approach

**Primary realtime source = `trip_updates.json`** — read the inbound run's predicted `arrival.time` at the terminus stop directly (it's already delay-aware, §2.1). **`vehicle_positions.json` is secondary**: `vehicle_id` continuity, live `current_status`, and detecting already-departed outbound runs. No self-computed delay propagation needed in v1.

Pipeline for `real` mode at a **departure terminus** stop:

```
schedule (base layer) ─┐
                       ├─► merge/annotate ─► Arrival[] with estimated departures
trip_updates (RT)     ─┤
vehicle_positions (RT)─┘  (optional cross-check / already-departed / vehicle_id)
```

1. Compute the scheduled outbound departures from the terminus (existing `nextDepartures`).
2. Fetch `trip_updates`; select **inbound-to-terminus** entities (trip whose terminal stop is this stop, i.e. a `stop_time_update` for `NUXT_STOP_ID` that is the trip's last). Read the predicted `arrival.time` at the terminus → `predicted_arrival`.
3. (Optional) Fetch `vehicle_positions` to detect **already-departed** outbound runs (an in-progress vehicle on a `desde_<terminus>_…` outbound trip) so their scheduled slot is dropped/marked, not shown as still upcoming; and to attach `vehicle_id`.
4. Match inbound predicted arrivals to scheduled departure slots (§6) and produce `estimated_departure = max(scheduled, predicted_arrival + BOARDING_BUFFER)`.
5. Slots with no matched inbound bus fall back to the scheduled time (today's behavior). Whole thing degrades to pure schedule when the feed is unhealthy/empty.

`BOARDING_BUFFER = 60 s` (user decision — "boards and departs immediately" + a small fixed buffer).

---

## 4. bUCR network facts (so agents don't re-derive)

Single route `bUCR`. Service `entresemana` (Mon–Fri; holiday exceptions in `calendar_dates.txt`). Terminus stop `bUCR_0_01` = Educación. Trip-id encodes everything (no `block_id` exists — see §7).

Trip families (name pattern → count):
- `desde_educacion_a_odontologia_sin_milla_entresemana_HH:MM` — **outbound from terminus** (dir 0, →Odontología)
- `desde_educacion_a_odontologia_con_milla_entresemana_HH:MM` — outbound, longer "milla" loop (dir 0, →Odontología). Evening only (from 19:00).
- `desde_odontologia_a_educacion_entresemana_HH:MM` — **inbound to terminus** (dir 1, terminal `bUCR_0_01`)
- `desde_edufi_a_educacion_entresemana_21:20` — single late inbound to terminus (terminal `bUCR_0_01`)
- `desde_odontologia_a_artes_*`, `desde_artes_a_odontologia_*` — the *other* terminus (Artes, `bUCR_0_02`); **not** feeders for Educación. Exclude.

Do **not** hardcode these names. Derive "inbound to this stop" generically: a trip is an inbound feeder for stop `S` iff its **last `stop_sequence` is at `S`** (the app already computes each stop_time's `isBoardable`, which is false at a trip's last stop — reuse/extend that terminal-stop detection). "Outbound from `S`" iff its **first boardable stop_time is at `S`** (`stopSequence` minimal, `isBoardable`). This keeps the feature correct for any terminus, matching the codebase's stop-agnostic ethos.

### Scheduled interline (evidence the chaining is real)

Inbound arrival at `bUCR_0_01` vs next outbound departure — the timetable itself encodes a consistent ~3-minute turnaround for the core of the day:

```
06:40 dep ← 06:37 arr (+3m)     08:00 dep ← 07:57 arr (+3m)
07:10 dep ← 07:07 arr (+3m)     08:35 dep ← 08:17 arr (+18m, irregular layover)
07:30 dep ← 07:27 arr (+3m)     06:20 dep ← (no feeder: first pull-out of day)
```

Implications for pairing (§6): usual turnaround ≈ 3 min, but **not constant** (18 min layovers occur), and **some departures have no feeder** (depot pull-outs, first of day). The matcher must tolerate a variable layover window and the no-feeder case.

---

## 5. Predicted arrival at the terminus (read straight from `trip_updates`)

Databús already produces a delay-aware prediction, so v1 just **reads** it — no propagation math.

For each in-progress `trip_update` entity:
1. Determine whether the trip is an **inbound feeder** for this terminus: it has a `stop_time_update` whose `stop_id == NUXT_STOP_ID` and that stop is the trip's **terminal** stop (last `stop_sequence` in the static schedule for that trip; equivalently the entry with the max `stop_sequence` in the update). Outbound trips departing the terminus won't have a future `stop_time_update` at the terminus once running, so they won't be picked up here — correct.
2. `predicted_arrival` = that entry's `arrival.time` (fall back to `departure.time` if `arrival` absent).
3. `uncertaintySeconds` = that entry's `arrival.uncertainty` (currently flat 120).
4. `vehicleId` = `entity.id` (carry through for §6 v2 and dedupe).

Edge handling:
- If the entity's trip is not in the static schedule (`schedule_relationship: ADDED` / unknown `trip_id`), still allow it through if it carries a terminus `stop_time_update` (fail open to real data), but it can't be schedule-matched — treat as an extra early departure or ignore per §6.
- Match the terminus entry by `stop_id`, never by array index (`stop_sequence` is non-contiguous).
- If an inbound entity has **no** `stop_time_update` at the terminus yet (early in its run, terminus beyond the horizon the feed emits), skip it this cycle; it'll appear once the prediction reaches that stop.

**Fallback propagation (only if needed):** should a real inbound sample turn out to omit the terminal-stop prediction, compute it from `vehicle_positions` instead — anchor on `current_stop_sequence`, `delay = max(0, now_rt − sched_arrival_at(current_stop))`, `predicted_arrival = sched_arrival_at(terminal) + delay`, using `time.ts::agencyLocalDay` and exact (non-index) sequence lookups. This is a contingency, not the v1 path — decide after capturing an inbound sample (§9).

---

## 6. Matching inbound buses to departure slots

Goal: assign each predicted inbound arrival to the scheduled outbound departure it will become, then set that slot's estimate.

v1 — **schedule-adjacency greedy match**:

- `slots` = upcoming scheduled outbound departures from the terminus (sorted asc), each with `scheduled_epoch`.
- `arrivals` = inbound predicted arrivals (sorted asc), each with `vehicle_id`, `predicted_arrival`.
- Parameters: `MAX_LAYOVER_S` (window a bus may wait at the terminus before its run; default ~1200 s / 20 min to cover the observed 18-min case) and `MAX_EARLY_S` (how far before a slot's scheduled time an arriving bus may be its feeder; small, e.g. 300 s — a bus arriving well before a slot more likely feeds an earlier slot).
- Greedy: iterate slots in order; for each unclaimed slot, pick the earliest unclaimed arrival with `predicted_arrival ≤ scheduled_epoch + MAX_LAYOVER_S` and `predicted_arrival ≥ scheduled_epoch − MAX_EARLY_S`. If found: `estimated_departure = max(scheduled_epoch, predicted_arrival + BOARDING_BUFFER)`; mark both claimed. If none: slot keeps its scheduled time (no-feeder / pull-out case).
- Any arriving bus not matched to a slot is ignored (its slot may be beyond the board's horizon).

**`vehicle_id` continuity (upgrade, note for v2, not required for v1):** because both feeds key `entity.id = vehicle_id`, once an outbound run starts you can confirm the same `vehicle_id` that was inbound is now outbound, validating/repairing the schedule-adjacency guess empirically. v1 doesn't need it, but preserve `vehicle_id` through the pipeline so v2 can add it.

Already-departed outbound handling: if a `vehicle_positions` entity is on an **outbound** trip from the terminus (first boardable stop = terminus) and has `current_stop_sequence` past the terminus (or `start_time` matches a slot), that slot has **left** — drop it from upcoming (or mark `departing`) so the board doesn't show a scheduled departure that already rolled.

---

## 7. No `block_id` — accept the heuristic, advocate the fix

`trips.txt` has **no `block_id`** (confirmed: columns are `route_id,service_id,trip_id,trip_departure_time,trip_headsign,trip_short_name,direction_id,shape_id,wheelchair_accessible,bikes_allowed`), and the user has no way to add one right now. So the static feed does not authoritatively link an inbound trip's vehicle to the next outbound trip. §6 schedule-adjacency is a heuristic with known failure modes (pull-outs with no feeder; irregular layovers). It is acceptable for v1 because the timetable's turnaround is mostly clean and the failure mode degrades to "show scheduled time" — never worse than today.

**Recommended follow-up (track separately):** petition the Databús/GTFS side to emit `block_id` (or any trip-to-trip interline field). One column makes the pairing authoritative for every consumer, not just this screen.

---

## 8. Concrete implementation workstreams

Split for parallel Sonnet agents. Keep the codebase's conventions: small pure functions, deliberately-never-throws realtime path, unit tests alongside (`tests/`), Nuxt `runtimeConfig` (`NUXT_*`) for config. Do **not** touch `fake`/`demo` mode behavior.

### WS-A — inbound-terminus extraction from `trip_updates` (pure core)
- Extend `server/utils/realtime-mode.ts` (it already defines `DatabusTripUpdateFeed` and fetches `trip_updates.json`) rather than starting from scratch.
- New pure fn `extractInboundArrivals(feed, gtfs, stopId, nowEpochSeconds) → InboundArrival[]` where `InboundArrival = { vehicleId, tripId, predictedArrival, uncertaintySeconds }` (§5). Selects entities whose terminus `stop_time_update` (`stop_id == stopId`, terminal) exists; reads `arrival.time`.
- Fixtures: `design/feed-samples/trip_updates.inbound.sample.json` is the **primary** test input (a live inbound run with a `bUCR_0_01` terminal-stop prediction); `trip_updates.sample.json` is the outbound counter-case (must yield no inbound arrival).
- (Optional) `server/utils/vehicle-positions.ts`: `DatabusVehiclePositionFeed` type + never-throw `fetchVehiclePositions` (same timeout/stale discipline as `fetchRealtimeArrivals`) for the secondary uses in §3. Fixture: `design/feed-samples/vehicle_positions.sample.json`.

### WS-B — terminus prediction/matching core (pure, the heart)
- New `server/utils/terminus-prediction.ts`.
- `matchArrivalsToSlots(scheduledSlots, inboundArrivals, params) → Map<slotTripId, EstimatedDeparture>` (§6), producing `estimated_departure = max(scheduled, predicted_arrival + BOARDING_BUFFER)`.
- Trip-vs-terminus classifiers: `isInboundFeeder(gtfs, tripId, stopId)` (terminal stop == S), `isOutboundFrom(gtfs, tripId, stopId)` (first boardable == S). Reuse/extend `gtfs.ts` terminal-stop logic; consider precomputing each trip's terminal `stop_id` in `GtfsData` at parse time (the parser already tracks `maxStopSequenceByTrip`).
- Unit tests: on-time bus (predicted ≤ scheduled ⇒ scheduled wins), late bus (predicted+buffer > scheduled ⇒ pushed out), no-feeder slot (schedule kept), irregular ~18-min layover still matches within `MAX_LAYOVER_S`, unknown/ADDED trip handling, terminus matched by `stop_id` not index, post-midnight service day.

### WS-C — wire into `real` mode, terminus-gated
- In `server/api/arrivals.get.ts` `real` branch: when the configured stop is a departure terminus **and** the `trip_updates` feed is healthy, produce arrivals via schedule + prediction merge; else fall back to schedule exactly as today. Preserve existing `realtimeFallback` semantics and `source`.
- Terminus-gating: recommend an explicit opt-in flag `NUXT_TERMINUS_PREDICTION` (default off) so non-terminus deployments are unaffected; optionally auto-detect (stop is both some trip's first-boardable and some trip's terminal). Document in `.env.example`.
- Note the existing non-terminus `real` path (surfacing `trip_updates` arrivals *at* the stop for a mid-route stop) stays valid and unchanged — the predictions there are real too. This feature is purely the terminus add-on.

### WS-D — types + UI surfacing
- Extend `shared/types.ts` `Arrival`: add optional `estimated?: boolean` (true when the time came from RT prediction rather than pure schedule) and keep `uncertaintySeconds`. Consider `scheduledEta?: number` so the UI can show "08:00 → ~08:07" if desired.
- `ArrivalSource` already has `realtime`; a predicted-from-schedule+RT board is still `source: 'realtime'` (it used live data). Reflect fallback with the existing `realtimeFallback`.
- UI (`app/…/ArrivalRow.vue` + wherever rows render): badge an estimated/live row distinctly from a pure-schedule row (small "en vivo"/estimate indicator), and optionally show the delay. Match infobus-web conventions and the existing `viaMilla` badge styling. Respect the "floor at schedule; never show earlier than timetable" rule visually.

### WS-E — config + docs
- `.env.example` + README "Configuration" table: new vars — feed base URL / file paths for `vehicle_positions.json` (see §9 — confirm exact path), `NUXT_TERMINUS_PREDICTION`, `BOARDING_BUFFER` seconds (default 60), `MAX_LAYOVER_S`, `MAX_EARLY_S`, and the `vehicle_positions` stale threshold.
- README "How it works": document the terminus-prediction behavior and, importantly, the **honest caveat** that it only works when inbound runs actually telemeter, and that `trip_updates` ETAs are intentionally ignored while Databús ships `fake_stop_times`.

### Test/verification (all workstreams)
- `pnpm test` (Vitest), `pnpm run lint`, `pnpm run typecheck`, `pnpm run build` must stay green.
- Add fixtures under `tests/` for `vehicle_positions` feeds; the prediction core is the high-value unit-test target (mirror the existing `deriveArrivalsFromFeed` test approach).

---

## 9. Open verification items (resolve before/at implementation)

1. **Feed URL — RESOLVED.** Base `https://app.167.233.130.36.sslip.io`, paths `/feed/realtime/{trip_updates,vehicle_positions}.json`, both live and returning real data. Set `NUXT_DATABUS_BASE_URL=https://app.167.233.130.36.sslip.io`. (Confirm this host is the intended production URL for the Pi, or whether a stable DNS name will replace the `sslip.io` IP-encoded host before the event.)
2. **Inbound sample — CAPTURED & VALIDATED.** `design/feed-samples/trip_updates.inbound.sample.json` + `vehicle_positions.inbound.sample.json` hold a live inbound run (`desde_odontologia_a_educacion_entresemana_11:25`, dir 1, `IN_TRANSIT_TO` seq 3). Its `trip_update` **does** include the terminal stop `bUCR_0_01` (seq 9) with `arrival.time` = 11:42:12, ~7.7 min ahead of the live position. So §5's read-directly path is confirmed: read `arrival.time` at `stop_id == bUCR_0_01`. Build the WS-A/WS-B tests against these fixtures.
3. **Prediction quality under lateness — mechanism confirmed, magnitude unverified.** On this on-time bus the predicted terminal arrival (11:42:12) matched schedule (11:42:18) within 6 s, and it's clearly position-anchored (7.7 min out from seq 3). Still worth one capture of a deliberately-late inbound run to watch `arrival.time` move past schedule, but the read-side design needs no change either way (we just consume `arrival.time`).
4. **`block_id`** — advocate adding it upstream (§7); if it lands, replace §6 heuristic with authoritative interline.

---

## 10. Explicitly out of scope for v1

- Self-computed delay propagation (Databús already predicts; only a contingency — §5 fallback).
- `vehicle_id`-continuity confirmation of pairings (v2 upgrade — §6).
- Non-terminus stops (feature is opt-in and terminus-only — §8 WS-C).
- Any change to `fake` or `demo` mode.
- ServiceAlerts (Databús emits none — stub).

---

## 11. One honest caveat to keep visible

None of this helps if, at the real deployment, inbound runs are **not** dispatched and telemetering — then `runs:in_progress` is empty, `vehicle_positions` is empty, and the board correctly falls back to the (drifting) schedule. This is a data/operations precondition, not something screen code can fix. During testing the user acts as dispatcher and starts every run via the simulator, so the window is exercisable; the real event needs the same operational commitment.
