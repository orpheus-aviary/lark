import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `tsc` emits compiled copies of these tests into dist/ — without this the
    // default glob would run every test twice.
    include: ['src/**/*.test.ts'],
    // better-sqlite3's native binding has a history of crashing under the
    // default worker_threads pool; child-process isolation avoids it (M1-14).
    pool: 'forks',
  },
});
