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

// `downloads/selection.ts` joined in N4f-1: a favourites folder can be five
// thousand rows, and the whole reason the ticking lives in one `Set` at the top
// of the page rather than in the rows is that a `FlatList` recycles them. That
// makes "全选 ticked every row" unobservable on a device — the rows off screen
// do not exist to look at — and trivial here. It imports one constant from
// `@lark/shared`.
//
// `downloads/multi-line.ts` joined in N4h-1 for the reason `selection.ts` did,
// one step further: a paste is a set of decisions about text — which lines are
// the same line, which cost a hop, what happens to the ones that cannot be
// downloaded — and none of them are visible on a screen that only shows the
// result. It imports `@lark/core/portable` and `@lark/shared` for real values,
// like the preflight beside it.

// `downloads/ensure.ts` joined in N4g-1 for the reason the store did, one step
// further out: it is the SAME race — last intent wins — stretched over a
// minute of network, and the phone can only ever show one run of it. The
// reverse test (a controller that ignores the generation must steal the
// speaker) is a mutation, which is a thing a device cannot be asked to be.
//
// `services/library.ts` joined in N4g-1 for `createCacheOptions`: three
// exclusion sources and a limit, all of them injected, deciding which files a
// drain is allowed to delete. Wrong here means "deleted the song that was
// playing", which is the kind of thing to find in a second rather than on a
// phone. It imports `@lark/core/portable` for real values and one TYPE from
// the boot sequence, which the compiler erases.

// `library/batch.ts` + `library/links.ts` joined in N4i-2, and both are about
// something a device answers expensively or not at all: a batch whose third
// item failed (you would have to break one delete on purpose, on a phone, with
// a real library), and WHICH url strings are allowed to reach
// `Linking.openURL` — a list that is only interesting for the entries nobody
// would type on purpose (`intent://`, `file://`).

// `ports/events.ts` joined in N5c, and it is the first `ports/` entry — every
// other one in that directory reaches a native module, this one reaches only
// `@lark/core/portable` and two pure app modules. What it holds is a switch
// with twelve arms whose effect is invisible on a screen: "the list did not
// refresh" says nothing about whether an event went to the wrong sink, was
// dropped, or was never emitted. The sinks are injected for exactly that.

// `sync/triggers.test.ts` joined in N5d, and it is the reason `app-state.ts`
// is a separate fifteen-line file: the machine that decides WHEN to ask for a
// round must not import React Native, or it could not be collected here. What
// it holds is the half the daemon does not have — a host that goes away — and
// both of its load-bearing rules fail invisibly on a device. A leaked timer
// shows up as a battery figure a week later; a session dropped on suspend
// shows up as somebody being asked to log in again for no reason they can
// describe.

// `library/import.ts` joined in N6a, and it is the entry whose test does
// something none of the others do: it stands in for the DESKTOP. Criterion 87
// is a parity claim between two hosts, so one side of it has to be checked
// somewhere that is not the phone — here, against the same constant the device
// probe compares to. What is in the module itself is the size gate, whose
// failure on a device is a screen that sits there while a video goes through a
// hash.

// `sync/devices.ts` joined in N6c for the same reason `identity/state.ts` did:
// a phone shows ONE confirmation — the one for the row somebody tapped — so
// "the current device is asked differently" cannot be observed there without
// revoking something for real.

// `identity/keys.ts` joined in N7d, and it is the only place criterion 113 is
// decidable: the two stores it names both reach SecureStore and cannot load
// under Node, while what has to be true — two workspaces never sharing a key,
// and `local` never moving off the ones an existing install already has — is
// arithmetic on strings. Getting it wrong means converging one library logs
// the other out, or reads a committed id belonging to somebody else and wipes.

// `ports/device-settings.ts` joined in N7a, and it is why the four lines that
// name `device.json` live in the boot sequence instead of in it: criterion 105
// is about a file that is missing, empty or corrupt, and none of those three
// states can be arranged on a phone without `adb` in an app-private directory.
// What is left in the module is the reading, the merge and the write queue.

// `ui/back.ts` joined in 0.1.1 ④, and it is the first `ui/` entry — every other
// file in that directory renders. This one holds only the ORDER the hardware
// back key is offered around, which is the part that cannot be checked on a
// phone: a wrong order looks like "back closed something", and the something
// it closed is only wrong if you knew what should have gone first. It matters
// because React runs effects child-first, so the naive stack asks the outer
// layer first — a bug with no visible symptom until somebody backs out of a
// selection and lands on another tab.

// `library/song-actions.ts` joined in 0.1.1 ⑩ for the reason `library/batch.ts`
// did: what a menu OFFERS is a list, and a phone can only show one of them at
// a time. The bug this replaces was exactly that — the same row's menu had
// nine entries in 歌曲 and one inside a playlist, and nothing anywhere said
// they were meant to be the same menu.

// `downloads/history.ts` joined in 0.1.1 ⑦, and what it holds is a rule with
// no visible half: 清空记录 and 删除一条 must not be undone by the next status
// event, even though the engine's in-memory ring still holds those tasks for
// the rest of the launch. On a phone that is "the row came back and I do not
// know why"; here it is four lines. The file reading is the other half —
// missing, empty and corrupt each have to read as "no history" WITHOUT
// replacing the bytes, and none of those three can be arranged on a device
// inside an app-private directory.

// `player/remote.ts` joined in 0.1.1 ⑬, and it is where two vocabularies meet:
// the media session says `previous`, `decideNext` says `prev`, and the payload
// comes across a boundary a PATCHED dependency owns. The rule that matters is
// the one for a command this build does not know — do nothing — and the only
// way to see it on a phone is to own a car stereo that sends one.

// `ui/add-draft.ts` joined in 0.5.0 ③ as the second `ui/` entry, for the
// reason the first one did: the page that holds the draft imports React
// Native and can never be collected here, so the rules about it — a share
// replaces the text and only the text, a submission empties the box and only
// the box — have to live somewhere that can be. What breaks if they are wrong
// is invisible in a screenshot: 存到 quietly back on 仅曲库.

// `ui/lyrics-scroll.ts` joined in 0.5.0 ⑥, and it is the entry whose bug was
// invisible for the same reason `downloads/rows.ts`'s was: a `ScrollView`
// clamps at the end of its content and says nothing, so "the last line stops
// halfway down" and "the scroll was asked for and refused" look identical on a
// phone. Here the two are a subtraction — the target offset against how far
// the content actually reaches.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/identity/keys.test.ts',
      'src/identity/state.test.ts',
      'src/library/batch.test.ts',
      'src/library/import.test.ts',
      'src/player/store.test.ts',
      'src/ports/device-settings.test.ts',
      'src/ports/events.test.ts',
      'src/sync/devices.test.ts',
      'src/sync/triggers.test.ts',
      'src/player/now-playing.test.ts',
      'src/player/prefetch.test.ts',
      'src/player/remote.test.ts',
      'src/downloads/foreground.test.ts',
      'src/downloads/history.test.ts',
      'src/downloads/budget.test.ts',
      'src/downloads/cancel.test.ts',
      'src/downloads/ensure.test.ts',
      'src/downloads/multi-line.test.ts',
      'src/downloads/preflight.test.ts',
      'src/downloads/replay.test.ts',
      'src/downloads/retry.test.ts',
      'src/downloads/rows.test.ts',
      'src/downloads/selection.test.ts',
      'src/services/library.test.ts',
      'src/share/draft.test.ts',
      'src/ui/back.test.ts',
      'src/ui/add-draft.test.ts',
      'src/ui/lyrics-scroll.test.ts',
      'src/library/song-actions.test.ts',
    ],
  },
});
