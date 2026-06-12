import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountAppHtml } from './helpers/mount-app.js';
import { stubCanvasContext } from './helpers/stub-canvas.js';

// Seam B′: the button-binding system, reached through the real boot. We mount
// app.html, stub the 2D context, and import main.js so initialize() runs and
// wires the buttons. Then a synthetic click proves the brush-shape buttons
// drive brushState — the ADR-0002 gap. Asserts observable state + visual class
// only, never how the binding is implemented.
async function boot() {
  vi.resetModules();
  mountAppHtml();
  stubCanvasContext();
  const main = await import('../public/modules/main.js');
  return main.State.brushState;
}

describe('brush-shape buttons drive brushState', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '';
  });

  it('clicking a brush-shape button sets brushState.brushShape', async () => {
    const brushState = await boot();
    document.getElementById('circleBtn').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }),
    );
    expect(brushState.brushShape).toBe('circle');
  });

  it('marks the clicked button as the selected (active) one', async () => {
    await boot();
    const circleBtn = document.getElementById('circleBtn');
    circleBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(circleBtn.classList.contains('selected')).toBe(true);
  });

  it('moves the selected state off the previous button when another is clicked', async () => {
    await boot();
    const circleBtn = document.getElementById('circleBtn');
    const boxBtn = document.getElementById('boxBtn');
    circleBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    boxBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(boxBtn.classList.contains('selected')).toBe(true);
    expect(circleBtn.classList.contains('selected')).toBe(false);
  });

  // Parity rule from the monolith (editor.js:9240/9258): the triangle button
  // selects the 'diamond' shape, which is stored back as 'triangle'. The
  // drawing/effects modules check brushShape === 'triangle', so storing
  // 'diamond' would silently break the triangle brush.
  it('stores the triangle button as the "triangle" shape, not "diamond"', async () => {
    const brushState = await boot();
    const triangleBtn = document.getElementById('triangleBtn');
    triangleBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(brushState.brushShape).toBe('triangle');
    expect(triangleBtn.classList.contains('selected')).toBe(true);
  });
});
