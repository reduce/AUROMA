import { describe, it, expect } from 'vitest';
import {
  rgbToHsl, hslToRgb,
  rgbToHsv, hsvToRgb,
  rgbToHex, hexToRgb,
  calculatePolygonBounds,
} from '../public/modules/utils.js';
import { clampView } from '../public/modules/zoom.js';

// Seam C — pure, DOM-free helpers. These tests assert return values only:
// no DOM, no rendering, no implementation internals. They run independently
// of the boot path so a math regression fails cheaply and loudly.

describe('color conversion round-trips', () => {
  // A color converted to another space and back must return to itself.
  // hslToRgb rounds to integer channels, so an exact RGB triple is the
  // cleanest round-trip subject (no accumulated float drift to tolerate).
  it('rgb -> hsl -> rgb returns the original color', () => {
    const [r, g, b] = [120, 200, 60];
    const [h, s, l] = rgbToHsl(r, g, b);
    expect(hslToRgb(h, s, l)).toEqual([r, g, b]);
  });

  // rgbToHsv returns [h, s, v] with s/v in 0..1; hsvToRgb takes the same
  // units and returns {r, g, b}. The round-trip therefore crosses an
  // array -> object boundary, so assert on the channels.
  it('rgb -> hsv -> rgb returns the original color', () => {
    const [r, g, b] = [120, 200, 60];
    const [h, s, v] = rgbToHsv(r, g, b);
    expect(hsvToRgb(h, s, v)).toEqual({ r, g, b });
  });

  // Hex is a lossless integer encoding, so the round-trip is exact.
  it('rgb -> hex -> rgb returns the original color', () => {
    const [r, g, b] = [120, 200, 60];
    expect(hexToRgb(rgbToHex(r, g, b))).toEqual({ r, g, b });
  });
});

describe('polygon bounds', () => {
  // Each extreme comes from a different vertex, so a swapped axis or a
  // min/max mixup would fail this — the box is known by inspection.
  it('returns the tight bounding box of a set of points', () => {
    const points = [
      { x: 3, y: 7 },   // leftmost x is elsewhere; this owns... nothing extreme
      { x: -2, y: 4 },  // xMin
      { x: 8, y: 1 },   // xMax, yMin
      { x: 5, y: 10 },  // yMax
    ];
    expect(calculatePolygonBounds(points)).toEqual({
      xMin: -2, xMax: 8, yMin: 1, yMax: 10,
    });
  });
});

describe('view clamping', () => {
  // clampView only reads state.{zoomLevel,panX,panY} and canvas.{width,height},
  // so a plain object stands in for the canvas — no DOM required.
  const canvas = { width: 800, height: 600 };

  // At full view, any incoming pan is discarded and the content is centered.
  it('snaps pan to origin at full view (zoom <= 1.01)', () => {
    const state = { zoomLevel: 1, panX: 250, panY: -130 };
    expect(clampView(state, canvas)).toEqual({ panX: 0, panY: 0 });
  });

  // When zoomed in, an out-of-bounds pan is pulled back to the edge of the
  // allowed range. At 2x on an 800x600 canvas the bounds work out to
  // panX in [-800, 800] and panY in [-600, 610], so a far-overshot pan
  // lands exactly on the clamp edges.
  it('clamps an out-of-bounds pan to the edge of the allowed range when zoomed in', () => {
    const state = { zoomLevel: 2, panX: 5000, panY: -5000 };
    expect(clampView(state, canvas)).toEqual({ panX: 800, panY: -600 });
  });
});
