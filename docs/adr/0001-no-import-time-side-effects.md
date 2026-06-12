# Modules must not run DOM/canvas side-effects at import time

## Status

accepted

## Context

AUROMA was extracted from a 14,465-line monolith (`editor.js`) into ES modules by
an automated pass. In the monolith, everything shared one scope and ran after the
DOM existed, so code could freely read canvas elements and attach listeners at the
top level.

When that code was mechanically split into modules, several modules kept their
top-level side-effects. The worst case is `drawing.js`, which at module scope:

- destructures shared canvas refs eagerly — `const { baseCanvas, ... } = canvasRefs`
  (line ~62), capturing whatever value exists the instant the module is imported;
- attaches the canvas event loop eagerly — `[baseCanvas, paintCanvas, samplerCanvas]
  .forEach(canvas => canvas.addEventListener(...))` (line ~3009).

Because `main.js` imports every module *before* it calls `State.initializeCanvasRefs()`,
`canvasRefs` is not yet populated when `drawing.js` runs. `baseCanvas` is `undefined`,
the `.forEach` throws `TypeError: undefined is not iterable`, and the entire module
graph fails to load. The modular app, as committed, does not boot. The "zero breaking
changes / success criteria met" claims in the legacy refactor docs were never true.

The extraction also invented init functions that never existed in the monolith
(`initializeWallet`, `initializeZoom`, `initializeSelection` are called from `main.js`
but defined nowhere), because the author sensed init was needed but had no real API to
call.

## Decision

Modules must not perform DOM access, canvas access, listener attachment, or eager
destructuring of shared mutable refs (e.g. `canvasRefs`) at import time.

- All such wiring lives in an exported `initialize<Module>()` function.
- Shared refs are read lazily — `canvasRefs.baseCanvas` at call time, never destructured
  into a module-scope `const` at import time.
- `main.js` owns boot order: it populates state first
  (`State.initializeCanvasRefs()`), then calls each module's `initialize*()` in
  dependency order.

The invented init names in `main.js` are made real under this rule rather than stripped.

## Consequences

- Import order between modules stops mattering for correctness — a module can be
  imported before the DOM or before `canvasRefs` is populated without crashing.
- Every module that currently wires listeners at top level must be converted; this
  is the governing rule for the rest of the monolith→module extraction, not a one-off
  fix for `drawing.js`.
- Boot becomes explicit and debuggable: a failed init points at one `initialize*()`
  call instead of a silent module-graph load failure.

## Addendum: who owns the canvas-event loop

The monolith wires drawing, zooming, and selection in a *single*
`[baseCanvas, paintCanvas, samplerCanvas].forEach` loop (editor.js:8276), because a
`mousedown` means "draw", "select", or "zoom-drag" depending on `brushShape`/`isZooming`
— they are branches of one dispatch, not independent features.

Therefore `initializeDrawing()` owns the entire canvas pointer/wheel/touch event loop
(mousedown/mousemove/mouseup/wheel/touchstart/move/end), since `startDrag`/`drag`/
`endDrag` already live in `drawing.js` and already branch into selection and zoom.
`initializeZoom()` and `initializeSelection()` set up only their *non-canvas-event*
concerns (zoom buttons/reset, selection buttons/state).

This means `drawing.js` owns more than its name implies. That is a naming/decomposition
problem to address in a later pass — not a reason to scatter order-dependent listeners
across modules now. The invented `initializeWallet`/`initializeZoom`/`initializeSelection`
calls in `main.js` are made real, not stripped.
