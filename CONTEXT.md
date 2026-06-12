# AUROMA

A browser-based NFT image editor: a canvas painting/smearing tool with visual
effects, MIDI control, and on-chain minting. Mid-migration from a single monolithic
script into ES modules.

## Language

**Monolith**:
The original single-file implementation, `public/editor.js` (~14,465 lines). The
source of truth being extracted from; now orphaned (nothing loads it).
_Avoid_: legacy, old code

**Module**:
One of the ES modules under `public/modules/` that the live app is built from.
`main.js` is the entry point; the app loads only the modules, never the Monolith.
_Avoid_: file, component

**Extraction**:
The act of moving a function or block out of the Monolith into a Module, preserving
behavior. Tracked by `editor.js lines X-Y` provenance comments in the Modules.
_Avoid_: migration, port, refactor (refactor implies changing structure; Extraction
preserves it)

**Initialize**:
Module-owned setup — attaching listeners and reading DOM/canvas refs — exposed as an
`initialize<Module>()` function and called in order by `main.js` after state is ready.
Never done at import time (see ADR-0001).
_Avoid_: setup, boot, wire

**Canvas**:
One of the three stacked drawing surfaces — `base`, `paint`, `sampler` — referenced
through `canvasRefs` in state. The user paints across them as one logical surface.
_Avoid_: layer, surface

**Drag**:
A single pointer interaction across a Canvas — `startDrag`/`drag`/`endDrag`. The same
Drag means painting, selecting, or zoom-panning depending on the active brush shape
and zoom mode; these are branches of one dispatch, not separate gestures.
_Avoid_: stroke, gesture, pan
