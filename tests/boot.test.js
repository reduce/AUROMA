import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountAppHtml } from './helpers/mount-app.js';
import { stubCanvasContext } from './helpers/stub-canvas.js';
import { trackListeners } from './helpers/track-listeners.js';

// Seam B: importing main.js runs the real boot (top-level initializeCanvasRefs +
// initialize() against a ready DOM). We mount the actual app.html body so the test
// fails if a DOM id the boot path depends on goes missing, stub the 2D context
// (jsdom has none), and import main.js to drive the boot.
async function boot() {
  vi.resetModules();
  mountAppHtml();
  stubCanvasContext();
  const listeners = trackListeners();
  await import('../public/modules/main.js');
  return { listeners };
}

const CANVAS_IDS = ['baseCanvas', 'paintCanvas', 'samplerCanvas'];

describe('boot (initialize via main.js import)', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '';
  });

  it('runs to completion without throwing', async () => {
    await expect(boot()).resolves.toBeTruthy();
  });

  it('attaches pointer, wheel, and touch listeners to each canvas', async () => {
    const { listeners } = await boot();
    for (const id of CANVAS_IDS) {
      const canvas = document.getElementById(id);
      expect(canvas, `#${id} exists`).toBeTruthy();
      expect(listeners.eventsOn(canvas)).toEqual(
        expect.arrayContaining(['mousedown', 'mousemove', 'mouseup', 'wheel', 'touchstart']),
      );
    }
  });

  it('gives the zoom and wallet buttons click handlers', async () => {
    const { listeners } = await boot();
    for (const id of ['zoomBtn', 'walletConnectBtn']) {
      const btn = document.getElementById(id);
      expect(btn, `#${id} exists`).toBeTruthy();
      expect(listeners.eventsOn(btn)).toContain('click');
    }
  });

  it('mounts the real app.html — every DOM id the boot path wires is present', async () => {
    // If app.html drops an id the boot path depends on, the element is gone and
    // its wiring is silently skipped. This asserts the real markup still carries
    // every id the boot wiring targets, so id drift fails loudly here.
    const REQUIRED_IDS = [...CANVAS_IDS, 'zoomBtn', 'walletConnectBtn'];
    await boot();
    for (const id of REQUIRED_IDS) {
      expect(document.getElementById(id), `app.html is missing #${id}`).toBeTruthy();
    }
  });
});
