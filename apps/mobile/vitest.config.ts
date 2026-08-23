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
//
// `downloads/foreground.ts` joined in N4c-2 for the first reason again, at its
// sharpest: the states it has to get right — the quota expiring, a preflight
// that enqueues nothing, a service the system refused — are states a phone
// reaches rarely, slowly, or only after six hours of downloading. It imports
// one type from `@lark/shared` and nothing else.
//
// `downloads/cancel.ts` joined in N4d-1: criterion 23 is a claim about what a
// person is TOLD when a sweep hits a task past the commit point, and a phone
// can only be asked whether the file survived. The wording, the counts and the
// sweep order are worked out here.
//
// `share/draft.ts` joined in N4d-3, split out of the hook beside it for this
// reason exactly: `share/intent.ts` imports a native module and cannot load
// here, while the rules that matter — consumed once, taking clears it,
// announcing does not consume — import nothing at all.
//
// `downloads/rows.ts` joined in N4d-2 after the device found what it is for: a
// `FlatList` renders what fits, so a row sorted off the bottom of the screen is
// indistinguishable from a row that is not there. The ordering therefore cannot
// be verified by looking at the phone, only by looking at the function.
//
// `downloads/preflight.ts` joined in N4d-2 and is the first entry that reaches
// `@lark/core/portable` for real values rather than types. That is fine and
// deliberate: portable is Node-free by guard, so it loads here exactly as it
// loads on the phone — and what these tests are about is which of ITS functions
// get called, in what order, with what. The bilibili client is a fake with two
// methods, because two is all the preflight can reach.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/identity/state.test.ts',
      'src/player/store.test.ts',
      'src/player/now-playing.test.ts',
      'src/downloads/foreground.test.ts',
      'src/downloads/cancel.test.ts',
      'src/downloads/preflight.test.ts',
      'src/downloads/rows.test.ts',
      'src/share/draft.test.ts',
    ],
  },
});
