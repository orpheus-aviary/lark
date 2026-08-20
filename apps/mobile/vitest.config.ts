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
//
// `player/store.ts` joined the list in N3a on the same terms. It imports
// `@lark/shared` and a TYPE from `./driver` — type imports are erased, so
// expo-audio never loads — and what it holds is the race model: last intent
// wins, an operation only ever destroys the driver it built. Races are the
// part a device finds once in twenty runs, which makes them the part worth
// testing where a run costs a second.
//
// `player/now-playing.ts` joined in N3d for a third reason: criterion 17 is an
// arithmetic claim about how many times a song's lyrics get published, and the
// device is only asked to reproduce a number. This is where the number is
// worked out.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/identity/state.test.ts',
      'src/player/store.test.ts',
      'src/player/now-playing.test.ts',
    ],
  },
});
