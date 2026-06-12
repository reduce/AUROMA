import { describe, it, expect } from 'vitest';
import { stubCanvasContext } from './helpers/stub-canvas.js';

// jsdom has no real 2D canvas context, so boot/integration tests (issues #4, #6)
// must stub getContext for initializeCanvasRefs() / initialize() to run. This proves
// the shared stub helper those slices depend on returns a usable no-op context.
describe('stubCanvasContext', () => {
  it('makes canvas.getContext("2d") return a no-op context', () => {
    stubCanvasContext();
    const ctx = document.createElement('canvas').getContext('2d');
    expect(ctx).toBeTruthy();
    // a representative 2D-context method exists and is callable without throwing
    expect(() => ctx.clearRect(0, 0, 1, 1)).not.toThrow();
    expect(() => ctx.getImageData(0, 0, 1, 1)).not.toThrow();
  });

  it('returns the same context for the same canvas (stable refs)', () => {
    stubCanvasContext();
    const canvas = document.createElement('canvas');
    expect(canvas.getContext('2d')).toBe(canvas.getContext('2d'));
  });
});
