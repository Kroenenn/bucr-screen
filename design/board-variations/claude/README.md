# bUCR departure-board — design variations gallery

A decision aid for refining the kiosk board (`app/pages/index.vue` +
`app/components/ArrivalRow.vue`). It changes **nothing** in the app — it only
proposes and previews options.

## What's here
- **`index.html`** — a single, self-contained, offline gallery. Double-click to
  open (no build step, no network). Dark by default (the kiosk default); use the
  top-right button to preview light mode. Variations are grouped into categories
  (typography, density, clock, date, states, ETA format, row structure, degraded
  states, header, motion, labels, palette, estimated departures / terminus
  prediction) plus a **Synthesis** section that
  combines the strongest choices into whole-board proposals.
- **`variations/<tag>.json`** — one machine-readable file per variation (every
  tile except pure `baseline` tiles). Each encodes the exact, file-level design
  decision so it can be applied with near-zero guesswork.

## How to browse
1. Open `index.html`. Skim the category sections; every category starts with a
   `baseline` tile so each option is judged against the current design.
2. Each tile shows a **tag** (chip), a one-line description, and a live
   mini-board rendering the same fixed mock data with the variation applied.
3. Note the tags you like (e.g. `clock-secs-grey`, `state-color-split`). The
   Synthesis tiles show a few coherent full-board combinations.

## How a later agent applies a chosen variation
1. Read `variations/<tag>.json`.
2. For each entry in `changes`, edit the named real `file` at the named
   `selector`:
   - `kind: "css"` → apply the `declarations` (property → value) to that selector
     (scoped CSS in the `.vue` file, or a token in `app/assets/css/main.css`).
   - `kind: "markup"` → apply the `intent`/`detail` to the template.
   - `kind: "logic"` → apply the `detail` in `app/composables/useKioskClock.ts`
     or `app/components/ArrivalRow.vue`.
   - `kind: "token"` → re-map an existing CSS variable in `app/assets/css/main.css`.
3. Honor any top-level `"warning"` (motion tiles carry the no-`TransitionGroup`
   constraint — do not implement those without solving it first).
4. Synthesis JSONs list their component tags in `composes` and restate the merged
   `changes`, so a single synthesis file is self-sufficient.

## Ground rules encoded in every JSON
- Points only at real files: `app/pages/index.vue`,
  `app/components/ArrivalRow.vue`, `app/composables/useKioskClock.ts`,
  `app/assets/css/main.css`.
- **No new color hues** — amber = attention, green = live, blue = demo/brand —
  except the clearly-labeled **speculative** Palette category (`palette-*`).
