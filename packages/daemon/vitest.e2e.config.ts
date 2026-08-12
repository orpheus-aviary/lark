import { defineConfig } from 'vitest/config';

// The e2e suites, which the default config deliberately excludes: they need a
// real skybridge server (`sync.dual.e2e.ts`) or real daemon child processes on
// their own nests (`sync.files.e2e.ts`), and neither belongs in `just test`.
export default defineConfig({
  test: {
    include: ['src/**/*.e2e.ts'],
    pool: 'forks',
    // A round trip through a real server, three libraries, and (in the file
    // suite) daemon boots: minutes, not seconds.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
