# presentation

A minimal [Slidev](https://sli.dev) deck that demos the `bucr-screen`
departure board by embedding it live in an iframe, with a static
screenshot fallback for when the network doesn't cooperate.

This is a self-contained package — it is **not** part of the root pnpm
workspace (see `pnpm-workspace.yaml` at the repo root, which declares no
`packages` list, so nothing outside the root is a workspace member) and
it is excluded from the Pi's Docker build context via `.dockerignore`.
Installing or building it never touches the main `bucr-screen` app.

**Important:** because `presentation/` lives inside a directory tree
that pnpm still recognizes as a workspace (the root `pnpm-workspace.yaml`),
running plain `pnpm install` from here resolves the *root* project
instead of this one (it'll happily run the root app's `postinstall` and
skip installing this package's own dependencies). Always pass
`--ignore-workspace` when installing here, so pnpm treats this folder as
its own standalone project:

```bash
cd presentation
pnpm install --ignore-workspace
pnpm dev        # opens the deck at http://localhost:3030
```

## Swap in the real board URL

The deck embeds the board at a single placeholder URL:

```
https://simovi84.CHANGEME.ts.net
```

This appears in exactly **one** place: `presentation/slides.md`, in the
`<script setup>` block on the live-board slide, as the `BOARD_URL`
constant:

```js
const BOARD_URL = 'https://simovi84.CHANGEME.ts.net'
```

Once the Tailscale Funnel URL for the board is known, find-and-replace
that one line with the real HTTPS URL and the iframe slide will point at
the live board.

## Fallback screenshot

`presentation/assets/board-fallback.png` does not exist yet — see
`presentation/assets/README.md` for what to drop there. The fallback
slide (the one right after the live iframe) references it with a
relative path, so once the PNG is added, no other file needs to change.

## Build

```bash
pnpm run build   # slidev build --base /bucr-screen/
```

The `--base /bucr-screen/` matches the GitHub Pages sub-path this repo
deploys to (`https://kroenenn.github.io/bucr-screen/`). Output goes to
`presentation/dist/`.

## Deploy (GitHub Pages)

Handled by `.github/workflows/deploy-pages.yml` at the repo root: on
every push to `feat/presentation-iframe` (or a manual
`workflow_dispatch`), it builds this deck and publishes it to GitHub
Pages via `actions/upload-pages-artifact` +  `actions/deploy-pages`.

Once Pages is deployed, the deck is served at:

```
https://kroenenn.github.io/bucr-screen/
```

Note: GitHub Pages must be enabled for the repo with the source set to
"GitHub Actions" (Settings → Pages → Build and deployment → Source) for
the workflow's `deploy` job to succeed.
