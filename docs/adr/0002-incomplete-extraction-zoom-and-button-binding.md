# Two subsystems were never fully extracted from the monolith

## Status

accepted

## Context

While making the modular app boot (see ADR-0001), we found that the automated
extraction silently dropped two subsystems. The "completed / zero breaking changes"
refactor docs do not mention this; the code simply lacks the functions.

**1. Zoom-mode machinery (~390 lines).** Wheel-zoom works (`handleZoomWheel` was
extracted into `zoom.js`), but the zoom *button* depends on `enterZoomMode` (168 lines),
`exitZoomMode` (124 lines), `attachZoomDetoggleListeners` (74 lines), and
`isAnyModalOpen` (20 lines) — none of which exist in any module. The modular app has
half a zoom feature.

**2. Global button-binding system.** In the monolith, brush/effect/selection buttons
(`squareSelectionBtn`, `sweeperBtn`, `oilbarrelBtn`, etc.) are wired through one
`effectMap`-driven button map (editor.js ~2300), shared with the keyboard and MIDI
dispatch — not per-feature. This cross-cutting binding loop was never extracted. As a
result, `main.js`'s invented `initializeSelection()` is misnamed: selection buttons are
not a selection concern, and no module currently binds these buttons at all.

## Decision

For the boot milestone we extract only what makes the app load and the canvas usable,
and we record the rest rather than reconstructing it blind (no tests exist to catch
regressions in a large speculative port).

- `enterZoomMode` / `exitZoomMode` are reconstructed as **minimal stubs**: they toggle
  `zoomState.isZooming`, the button's active class, and selection-button enable/disable,
  and reset per-canvas `targetLocked`/pivot state. The deep interactive double-click /
  pan-pivot internals (~130 lines of the original `enterZoomMode`) are **deferred**.
- `initializeSelection()` does state setup only (clear selection state). It does **not**
  wire selection buttons — that is the global button-binding gap below.
- The global button-binding system (brush/effect/selection buttons) is **not** extracted
  here. It belongs in a dedicated pass, in `ui.js` / `constants.js`, not in the
  per-feature `initialize*()` functions.

## Consequences

- After boot: drawing (mouse + touch), wheel-zoom, the zoom-button toggle, and the
  wallet/network modal work. Brush/effect/selection *buttons* may be dead until the
  button-binding system is extracted.
- `main.js`'s init API (`initializeZoom` / `initializeSelection` / `initializeWallet`)
  does not match the real seams of the code. Treat these names as load-bearing-for-boot,
  not as an accurate module map. A later pass should move button binding to `ui.js` and
  reconsider whether `initializeSelection` should exist at all.
- Follow-ups, in priority order: (1) extract the global button-binding system; (2) port
  the deep `enterZoomMode`/`exitZoomMode` internals; (3) extract `commitActiveSelectionDrags`
  (called on zoom entry, currently skipped in the stub).
