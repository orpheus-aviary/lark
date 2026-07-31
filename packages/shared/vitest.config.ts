import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `tsc` emits compiled copies of these tests into dist/ — without this the
  // default glob would run every test twice.
  test: { include: ['src/**/*.test.ts'] },
});
