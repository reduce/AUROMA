import { vi } from 'vitest';

/**
 * jsdom does not implement the canvas 2D context. This installs a no-op stub on
 * HTMLCanvasElement.prototype.getContext so initializeCanvasRefs() / initialize()
 * (issues #4, #6) can run. The stub asserts wiring, NOT rendering — pixel behavior
 * is Seam D (Playwright, deferred).
 *
 * Each canvas gets one stable context object (so identity comparisons hold).
 * getImageData/createImageData return real ImageData-shaped objects so callers
 * that read `.data`/`.width`/`.height` don't blow up.
 */
const CONTEXT = Symbol('stubbed-2d-context');

function makeImageData(w = 1, h = 1) {
  return { data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h };
}

function makeContext() {
  // A Proxy makes every accessed method a callable no-op spy, so the stub never
  // throws "ctx.foo is not a function" no matter which 2D method the code calls.
  const real = {
    canvas: null,
    getImageData: vi.fn((x, y, w, h) => makeImageData(w, h)),
    createImageData: vi.fn((w, h) => makeImageData(w, h)),
    measureText: vi.fn(() => ({ width: 0 })),
  };
  return new Proxy(real, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // any other property is a no-op function (drawImage, clearRect, save, ...)
      target[prop] = vi.fn();
      return target[prop];
    },
  });
}

export function stubCanvasContext() {
  const proto = globalThis.HTMLCanvasElement?.prototype;
  if (!proto) throw new Error('stubCanvasContext requires a DOM (jsdom) environment');
  proto.getContext = function getContext() {
    if (!this[CONTEXT]) {
      const ctx = makeContext();
      ctx.canvas = this;
      this[CONTEXT] = ctx;
    }
    return this[CONTEXT];
  };
}
