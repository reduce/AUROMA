import { describe, it, expect } from 'vitest';
import { findInvalidModules, findUnresolvedImports } from './helpers/module-graph.js';

// Seam A (core): every Module under public/modules must parse as a valid ES module.
// A browser refuses to load a module-invalid file (e.g. the drawing.js brace bug,
// ADR-0003), so this gate fails loudly instead of only in the browser.
describe('module graph — ESM validity', () => {
  it('every module parses as a valid ES module', () => {
    const invalid = findInvalidModules();
    expect(invalid).toEqual([]);
  });

  // Seam A (imports): every named import from a sibling Module must resolve to a
  // real export — catches dangling imports like the calculatePolygonBounds bug
  // that loaded `undefined` at runtime.
  it('every named cross-module import resolves to a real export', () => {
    const unresolved = findUnresolvedImports();
    expect(unresolved).toEqual([]);
  });
});
