# `drawing.js` was never a valid ES module; validate with a real ESM parser

## Status

accepted

## Context

The modular AUROMA app never booted. Beyond the import-time side-effects (ADR-0001)
and the incomplete extraction (ADR-0002), the deepest cause was structural:
**`drawing.js` was not syntactically valid as an ES module.** Its `startDrag` function
(the largest in the file) was missing two closing braces — the
`squareSelection`/`circleSelection`/`basquiatSelection` branch opened a block that never
closed back to the function-body level. As a result every `export` *after* `startDrag`
was, to the parser, illegally nested inside it: "import/export cannot be used outside of
module code." The browser would refuse to load the module at all.

This defect was **pre-existing** — present in the original committed `drawing.js`
(git HEAD), not introduced by the finishing work. It went unnoticed because the only
validation in use was `node --check`, which checks files in **script (CommonJS) mode**
and does not enforce ES-module rules: it happily passed a file that no browser would
load as a module. The bug surfaced only when the file was parsed with real ESM semantics
(`@swc/core` with `isModule: true`), which is also what the Parcel build does.

The monolith's original `startDrag` (the extraction source) balances correctly, which
confirmed the modular copy lost braces during extraction and gave a reference for the
correct closing structure.

## Decision

1. Repair the brace imbalance by closing the selection branch and the function at the end
   of `startDrag`, verified by parsing the file with a real ESM parser (not `node --check`).

2. **All "does it boot / is it valid" verification must use real ES-module semantics** —
   the Parcel build, or an ESM parse (`isModule: true`) — never `node --check` alone.
   `node --check` on a `.js` file is script-mode and silently passes module-invalid code.

## Consequences

- With this fix the entire module graph parses as ESM, all named imports resolve, and
  `parcel build` succeeds — the app is structurally bootable for the first time.
- The project's verification gate (PRD Seam A) is an ESM parse + import-resolution check
  over `public/modules/*.js`, plus the Parcel build. Any future change that breaks module
  validity now fails loudly instead of only in the browser.
- This is the third defect class from the same automated extraction (import-time
  side-effects, dropped subsystems, brace corruption). Treat the extracted code as
  unverified until it parses as ESM and builds.
