// Pure logic only.
//
// `apps/mobile` is verified on a device: everything here that matters touches
// expo-sqlite, expo-file-system or SecureStore, none of which exist under
// Node. The one exception is D16's decision table (`identity/state.ts`), which
// imports nothing at all and is where both review rounds found their bugs — so
// it gets tests that run in a second instead of a build-install-tap cycle.
//
// `include` is deliberately narrow rather than the default glob: a test file
// that reaches for React Native should fail to be collected here, not fail
// mysteriously inside it.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/identity/state.test.ts'],
  },
});
