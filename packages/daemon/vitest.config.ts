import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `tsc` emits compiled copies of these tests into dist/ — without this the
    // default glob would run every test twice.
    include: ['src/**/*.test.ts'],
    // From M2 the daemon loads better-sqlite3 (through @lark/core), whose
    // native binding has a history of crashing under the default worker_threads
    // pool; child-process isolation avoids it (M1-14 / M2-17).
    pool: 'forks',
    // Child-process boot tests spawn a real daemon and wait for it to exit.
    testTimeout: 20_000,
  },
});
