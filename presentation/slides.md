---
theme: default
title: bUCR — Próximas salidas
info: |
  Live demo deck for the bUCR departure-board kiosk (bucr-screen).
  The centerpiece slide embeds the board over a Tailscale Funnel URL.
class: text-center
transition: fade
mdc: true
---

<!--
  ⚠️ SINGLE PLACE TO EDIT: the live board URL lives in slides.md, in the
  `board-frame.vue` component below, as the constant BOARD_URL.
  See presentation/README.md for how to swap it.
-->

# bUCR — Próximas salidas

Live departure-board demo

<div class="pt-8 opacity-70 text-sm">
  bucr-screen · departure board for a single bUCR stop
</div>

---
layout: default
---

<!--
  Centerpiece slide: the live board, embedded via iframe over a Tailscale
  Funnel HTTPS URL. The board's own layout is a kiosk aspect ratio, not
  16:9, so we render it at a fixed logical width/height and scale the
  whole thing down to fit the slide — no squish, no scrollbars.
-->

<div class="board-stage">
  <iframe
    class="board-iframe"
    :src="BOARD_URL"
    title="bUCR — Próximas salidas (live departure board)"
    loading="eager"
    referrerpolicy="no-referrer"
    sandbox="allow-scripts allow-same-origin"
  />
</div>

<div class="text-xs opacity-50 mt-2">
  Live · served over a Tailscale Funnel HTTPS URL
</div>

<style>
/*
 * ⚠️ SINGLE PLACE TO EDIT: replace the URL below with the real Tailscale
 * Funnel address once it's known (see presentation/README.md).
 */
.board-stage {
  --board-logical-width: 1280px;
  --board-logical-height: 800px;
  --board-scale: 0.62;

  width: calc(var(--board-logical-width) * var(--board-scale));
  height: calc(var(--board-logical-height) * var(--board-scale));
  margin: 0 auto;
  overflow: hidden;
  border-radius: 8px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.25);
}

.board-iframe {
  width: var(--board-logical-width);
  height: var(--board-logical-height);
  border: 0;
  transform: scale(var(--board-scale));
  transform-origin: top left;
  display: block;
}
</style>

<script setup>
// ⚠️ SINGLE PLACE TO EDIT — swap this for the real Tailscale Funnel URL.
// See presentation/README.md for instructions.
const BOARD_URL = 'https://occupation-stainless-recommendation-disturbed.trycloudflare.com'
</script>

<!--
Speaker notes:
This slide embeds the live board over a Tailscale Funnel HTTPS URL. It
depends on the venue's network reaching that URL. If it doesn't load in a
few seconds, or the network is unreliable, skip straight to the next
slide — a static screenshot of the same board.
-->

---
layout: center
---

<!--
  Fallback slide. Uses a relative <img> path (resolved by Vite at build
  time) rather than an absolute /public path, so the screenshot can live
  in presentation/assets/ alongside the deck instead of presentation/public/.
-->

<div class="fallback-stage">
  <img
    src="./assets/board-fallback.png"
    alt="Screenshot of the bUCR departure board showing próximas salidas"
  />
</div>

<div class="text-xs opacity-50 mt-2">
  Fallback screenshot — same board, no live network dependency
</div>

<style>
.fallback-stage {
  max-width: 70%;
  margin: 0 auto;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.25);
}

.fallback-stage img {
  display: block;
  width: 100%;
  height: auto;
}
</style>

<!--
Speaker notes:
FALLBACK SLIDE — use this if the live iframe on the previous slide didn't
load (bad venue wifi, Funnel down, etc). It's a plain screenshot of the
same board, so the talk reads as intentional either way. No live network
dependency here.
-->
