import { describe, it, expect } from 'vitest';

// Cycle 1 tracer bullet: prove the runner + config + npm script work end-to-end.
describe('test harness', () => {
  it('runs vitest in a jsdom environment', () => {
    // `document` only exists if the jsdom environment is active.
    expect(typeof document).toBe('object');
    expect(document.createElement('canvas').tagName).toBe('CANVAS');
  });
});
