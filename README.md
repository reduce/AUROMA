<div align="center">
  <img src="public/images/AUROMA25LOGO.png" alt="AUROMA" width="320" />

  **A decentralized glitch-art canvas editor with Web3 minting.**

  Paint, smear, and corrupt images in the browser — then mint the result as an NFT
  across Ethereum, Tezos, or Ronin.
</div>

---

## What is AUROMA?

AUROMA is a browser-based image editor built for glitch art. You load an image onto a
stack of canvases, then deform it with pressure-style brushes, pixel-smearing tools, and
a deep library of real-time effects. MIDI controllers can drive effects live. When you
like what you've made, you can mint it on-chain without leaving the app.

It runs as a static site — no backend, no build step required to use it.

## Features

- **Brushes & smearing tools** — box, circle, rectangle, triangle, melt, sweeper,
  oilbarrel, aesthetic-lines, jazz-scatter, sticker mode, and more
- **Selections** — square, circle, and freeform (basquiat) selection tools
- **Real-time effects** — neon, chromatic shift, glitch tide, binary rain, photo-CRT,
  caustics, fractal stretch, dither vibe, flicker negative, teleport, and ~20 others
- **Three-canvas workflow** — `base`, `paint`, and `sampler` surfaces painted as one
- **Zoom & pan** — wheel-zoom plus a dedicated zoom mode
- **Unlimited undo/redo** — memory-bounded history
- **MIDI control** — map effects to a connected MIDI device
- **Multi-chain minting** — ERC-721 / ERC-1155 on Ethereum, plus Tezos and Ronin

## Quick start

```bash
npm install        # install dev tooling (Parcel, Vitest)
npm run dev        # start the dev server (Parcel) and open the app
npm run build      # production build to dist/
npm test           # run the test suite (Vitest)
```

The app entry point is `public/app.html`. In production it loads only the ES modules
under `public/modules/` — no framework runtime.

## Architecture

AUROMA was extracted from a single ~14,500-line script into focused ES modules. Each
module owns one concern and is wired together at boot by `main.js`.

| Module | Responsibility |
| --- | --- |
| `state.js` | Centralized application state |
| `constants.js` | Effect map, key labels, configuration |
| `canvasManager.js` | Canvas setup, image loading, drag-and-drop |
| `drawing.js` | Brushes, smearing engine, the canvas event loop |
| `effects.js` | Real-time visual effects |
| `selection.js` | Square / circle / freeform selections |
| `zoom.js` | Zoom and pan |
| `history.js` | Undo / redo |
| `midi.js` | MIDI input |
| `blockchain.js` | Wallet connection and minting |
| `ui.js` | Modals and UI wiring |
| `main.js` | Boot order and initialization |

**Boot model.** Modules never touch the DOM or attach listeners at import time; all
wiring happens in `initialize<Module>()` functions that `main.js` runs in order after
state is ready. The reasons behind this and other structural decisions are recorded as
Architecture Decision Records in [`docs/adr/`](docs/adr/). The project's domain language
is defined in [`CONTEXT.md`](CONTEXT.md).

## Testing

Tests run under [Vitest](https://vitest.dev) in a jsdom environment:

- **Module-graph gate** — every module must parse as valid ESM and every cross-module
  import must resolve (catches the class of defect that previously kept the app from
  booting in the browser).
- **Boot integration** — `initialize()` is exercised against the real `app.html` DOM.
- **Unit tests** — pure helpers (color conversion, geometry, view clamping).

```bash
npm test
```

## Project status

AUROMA is mid-refactor: a deep cleanup of an automatically-modularized codebase. The app
now builds and boots as valid ES modules with a test harness in place. Remaining work is
tracked as issues and ADRs — notably the global button-binding system and the deeper
zoom-mode internals (see [`docs/adr/0002`](docs/adr/0002-incomplete-extraction-zoom-and-button-binding.md)).

## Credits & license

AUROMA is a fork of [ROBNESSVIRTUAL/AUROMA](https://github.com/ROBNESSVIRTUAL/AUROMA).
Released under **CC0-1.0** (public domain) — see [`LICENSE`](LICENSE).
