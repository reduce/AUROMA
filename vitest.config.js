import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom so boot/integration tests (issues #4, #6) can mount app.html and
    // dispatch DOM events. Pure-Node tests (the Seam A gate, pure-function units)
    // run fine under jsdom too.
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
  },
});
