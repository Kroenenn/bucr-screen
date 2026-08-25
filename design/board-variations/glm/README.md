# bUCR board — variation gallery (`glm`)

Offline, self-contained design-decision gallery for the bUCR departure-board kiosk.
Open `index.html` by double-click; browse the categories (A–L) and pick favorite tiles.

- Every tile shows a `tag` chip; the machine-readable spec for that variation lives at
  `variations/<tag>.json` (real files/selectors, concrete CSS declarations, palette-legal).
- `baseline` tiles reproduce the current shipped design (no JSON).
- The **M. Síntesis** section composes per-category winners; its JSONs restate the merged
  changes and list the component tags in `composes`.
- Categories **J (motion)** and **L (palette)** are exploratory/speculative — read their
  warnings before considering them for implementation.

To apply a chosen variation: hand `variations/<tag>.json` to an implementation agent (or
apply it yourself) — each `changes[]` entry names the real file, the kind of change
(css/markup/logic/token), the selector, and the exact declarations or guidance.
