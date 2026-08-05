import { defineConfig } from 'vitest/config';

// Main/preload/shared tests run under plain Node — the modules under test are
// electron-free by construction (wiring lives in thin electron-importing
// files that have no tests). T2 turns this into a two-project setup and adds
// the jsdom renderer side.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/main/**/*.test.ts', 'src/preload/**/*.test.ts', 'src/shared/**/*.test.ts'],
  },
});
