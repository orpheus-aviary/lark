# mobile-foundation — Phase B N0b platform spike

Answers one question: **can Android carry lark at all?** Not "does lark work on
Android" — that is N1 onward. GO/NO-GO criteria are §3.2 of
`docs/plans/2026-08-17-phase-b-mobile-n0.md`; results go in that document's §9.

Kept after N0b, like `spikes/media-protocol/` was: N2 ports the SQLite shim and
the bootstrap out of here, and having the original to compare against is worth
more than a clean directory.

## The boundary — read this before adding an import

core's business modules are Node-only until N1 ports them (`wbi.ts` reaches
straight for `node:crypto`, `backfill.ts` for `node:fs/promises`, and apply's
dependency graph gets to both). Metro cannot resolve them. So:

1. **Of our own packages, the BUNDLE may import exactly three**:
   `@lark/core/portable`, `@lark/shared`, and the skybridge SDK
   (`@orpheus-aviary/skybridge-client` / `-proto`).
   `scripts/check-spike-mobile-imports.sh` enforces it and runs in `just check`.
   Third-party dependencies are out of that guard's scope by design.

   The one exemption: `scripts/*.mjs` run on the desktop under Node, never in
   Metro's graph, and their job is to produce the fixtures the device is
   forbidden to compute — so they may use the real `@lark/core`. Producing a WBI
   signature with anything else would be the self-agreement the guard exists to
   prevent.

2. **Never copy core's logic in here to "verify" core.** A probe that
   reimplements WBI signing is verifying the reimplementation. Probes send bare
   requests and assert PLATFORM behaviour; anything that needs core to compute
   it arrives as a **fixture produced on the desktop by the real core** —
   the signed URL, the canonical string and its expected digest, the exact
   header set `openAudio()` sends. Criteria 19 and 23 are written in that shape.

3. **The business graph is re-verified for real at N1's exit** (criteria
   R1–R5), on this same device, with core's actual code. Until then nothing
   here should be read as "core works on Android."

## Verification classes

Criteria fall into three kinds, and only the first is self-checking:

| kind | where | examples |
|---|---|---|
| automatic assertions | in-app judgement panel | contract harness, migrations, prepare/finalize counts, jank timings, crypto benchmark, fetch probes |
| host scripts | this Mac, over adb | `dumpsys meminfo` sampling, `bmgr backupnow`/restore, manifest and XML checks |
| human observation | the device, by hand | lock-screen metadata and controls, headphone unplug, audio focus, keystore recovery drill, the share intent's actual feel |

## Layout

- `index.ts` / `src/App.tsx` — the judgement panel. Every panel runs on a
  button, not on mount: the contract executes ~13k statements synchronously and
  a screen that froze on every Metro reload would be unusable.
- `src/probes.ts` — what criterion 12 actually proves: each entry USES something
  from one of the three allowed packages, so a resolution failure is a bundling
  failure rather than a wrong number on screen.
- `src/sqlite/shim.ts` — `SqliteLike` over expo-sqlite, per-call transient.
  `src/sqlite/hooks.ts` feeds it to the contract (and carries `leakOnError`, the
  on-device half of criterion 6). `src/sqlite/op-sqlite-hooks.ts` is the
  criterion 16 comparison.
- `src/panels/` — bootstrap rehearsal (15), contract driver (14), the two
  drizzle probes (17a/17b) over a shared counting Proxy, N0b-3's three:
  `workload.ts` (18, statement-shape proxies), `crypto.ts` (20), `globals.ts` (21),
  and N0b-4's four: `bilibili.ts` (23 + criterion 19's stream half),
  `skybridge.ts` (22), `playback.ts` (19 — expo-audio on the raw fMP4),
  `share-intent.ts` (24) and `backup-identity.ts` (26 — copy-then-open, the
  SecureStore side, the 50MB fixture and the racing-writer reverse test).
  `share-intent.ts` is a hook, not a button: an intent that launched the app is
  already waiting when JS starts, so it is called from `App` itself and its
  section is the first one on screen.
- `plugins/with-backup-rules.js` — the CNG plugin that owns D16's Android side:
  two rule files under `res/xml/` and the two manifest attributes pointing at
  them. expo-secure-store installs its own version by default, which is why
  `app.config.ts` tells it to stand down.
- `src/fixtures.ts` — the N0b-4 fixtures, fetched from the probe host at run
  time rather than bundled. bilibili's stream URLs expire in about two hours and
  the skybridge account is created per `sync-host.mjs` run; compiling either in
  would mean a rebuild per staleness.
- `src/measure.ts` — §3.2a in code: warmup, nearest-rank p95, cold-start max —
  and `judge()`, which returns `null` on a dev bundle so that a debug run
  cannot render a verdict at all.
- `src/desktop-fixtures.ts` — GENERATED (`just spike-mobile-fixtures`). The
  expected digests, UTF-8 byte lengths and base64 decodes, computed on the
  desktop by `node:crypto` and `Buffer` — the implementations core calls. A
  device that produced its own expectations would only be agreeing with itself.
- `scripts/` — host-side, never bundled: `probe-host.mjs` (the fetch peer, the
  results sink, the fixture service and the SSE nudge), `drive.mjs` (press the
  panel's buttons by label), `make-desktop-fixtures.mjs`,
  `make-network-fixtures.mjs` (the WBI three-piece, `openAudio()`'s header set
  and the two audio tracks, all from the real core), `sync-host.mjs` (a
  throwaway skybridge server for criterion 22), `backup-audit.mjs` (criterion
  26's manifest / rule-file / `bmgr` layers).
- `app.config.ts` — the whole native configuration (CNG). `android/` is
  generated and untracked; anything that can only be said by hand-editing it
  belongs in a config plugin.
- `metro.config.js` — monorepo roots, with hierarchical lookup disabled so a
  package that resolves only by accident of hoisting fails here, not on a phone.

## The drizzle patch

`patches/drizzle-orm@0.38.4.patch` (repo root) fixes the Expo driver's missing
`finalizeSync` — unpatched, 10,000 selects prepare 10,000 statements and release
none. It only touches `expo-sqlite/session.*`, which the desktop never loads.
pnpm keys it to `drizzle-orm@0.38.4`, so a version bump makes the install fail
rather than silently dropping it; the panel's counting assertions are the second
backstop. Full reasoning: subplan §9, criterion 17.

## Driving it from the host

```
node scripts/drive.mjs tap "Run contract"   # finds the button by label, scrolls, taps
node scripts/drive.mjs dump                 # every visible label
node scripts/drive.mjs shot out.png         # screencap, refuses unless we are in front
node scripts/drive.mjs senders              # every text/plain SEND handler the system knows
node scripts/drive.mjs share "text"         # hand us a share; share-cold force-stops first
```

It looks the button up in the accessibility tree instead of tapping fixed
coordinates, because the panel grows and a stale coordinate presses whatever
moved into its place. It also refuses to act unless the spike is the resumed
activity — `pidof` says yes for a backgrounded app, and twice during N0b the
evidence captured was of one of the user's own apps.

Two ways to leave the app by accident: the dev menu closes on ONE back press and
exits on the second, and fast repeated swipes register as the home gesture (so
`drive.mjs` scrolls slowly and away from the edges).

Results go to the screen, and:

- **debug builds** also print to logcat (`CONTRACT`, `MATRIX`, `DRIZZLE`,
  `WORKLOAD`, `CRYPTO`, `GLOBALS` prefixes);
- **release builds do not** — MEASURED in N0b-3: zero lines for any prefix, and
  no `ReactNativeJS` tag at all. RN wires `console` to native logging as part of
  its dev tooling, so the build every numeric criterion must use is exactly the
  one that cannot print. That is why the panels POST to
  `scripts/probe-host.mjs`, which writes JSON into `.runtime/` — and why the
  POST is not a convenience.

Transcribing p95s off a screenshot is how a plan document acquires a number
nobody can trace.

`drive.mjs audio` reads `dumpsys audio` and `dumpsys media_session`, because JS
cannot hear the speaker. Criterion 19 needs it twice over: `player.playing`
stays true while the audio system has us paused for focus, and `release()`
without a preceding `pause()` leaves an AudioTrack running that no JS handle can
reach (measured — expo-audio 57.0.3 still has expo/expo#47569; recovery is
`adb shell am force-stop`).

**A dev client that lost Metro does not come back.** Toggling Wi-Fi (criterion
23's cellular pass does) drops the connection, after which edits silently stop
arriving and the panel looks perfectly normal — the only tell is a stale label.
Deep-linking it at `http://localhost:8081` over `adb reverse` did not help, and
this device's `adb logcat` is empty, so there is nothing to read. Rebuild with
`just spike-mobile-android-release`: the bundle is inside the APK, and §3.2a
prefers it anyway.

## Running it

```
just spike-mobile-typecheck        # types only; not in the root tsc -b
just spike-mobile-prebuild         # regenerate android/ from app.config.ts
just spike-mobile-android          # debug build + install + Metro
just spike-mobile-android-release  # release build — REQUIRED for every numeric criterion
just spike-mobile-probe-host       # adb reverse + the fetch peer / results sink
just spike-mobile-fixtures         # regenerate src/desktop-fixtures.ts
just spike-mobile-fixtures-network # N0b-4: WBI three-piece + header set (+ --audio)
just spike-mobile-sync-host        # a real skybridge server on :8097
just spike-mobile-backup-audit     # criterion 26's three layers (APK + bmgr)
```

## The audio fixtures, and why a stream URL is not portable

`just spike-mobile-fixtures-network --audio` downloads bilibili's raw AAC-in-MP4
bytes with no remux at all — criterion 19 asks whether Android plays what
bilibili sends, and a fixture that had been through ffmpeg would answer a
friendlier question. Two tracks: a 2:17 song from the user's own favlist (its
shortest entry — there is no ~1min track in it) and a 37:07 part for the seek
and duration work, which had to come from a search because nothing in the
favlist reaches 35 minutes.

MEASURED, and it shapes the probes: playurl hands out a CDN node chosen for the
**caller's** address. The URL minted on the desktop's Wi-Fi named
`cn-bj-cc-03-02.bilivideo.com`, and over China Telecom 5G that host resolves but
never answers — from the app and from `adb shell curl` alike. So the stream
probe runs its header matrix twice: once against the desktop's URL and once
against one the phone asked for itself. Only the second can answer "can this
radio pull audio".

**A release APK can still run the debug bundle.** `expo-dev-client` is in this
spike's dependencies, so `expo run:android --variant release` launches it
pointing at the dev server; if Metro is up, the release shell happily loads
Metro's JS. The panel prints which bundle it is (`release bundle · Hermes ·
performance.now()`) from `__DEV__`, and every numeric verdict is withheld on a
dev bundle. Check that line before quoting a number.

`JAVA_HOME` is pinned to Temurin 17 inside those recipes. It is deliberately not
exported globally: this machine's default is JDK 25, which the rest of the repo
is fine with and React Native's Gradle line is not.

Debug builds measure the debugger. §3.2a binds every numeric criterion to
release builds on the one frozen device recorded in the subplan's §9.

## The share intent, and what bilibili actually sends

`share` / `share-cold` send an ACTION_SEND with `-p <package>` rather than
naming the activity: the intent still has to match the filter the config plugin
added, which is most of what criterion 24 asks. They then read the arrival back
out of `.runtime/` and compare it to what was sent, **character by character** —
the screen can show that a share arrived and looks right, but not that a
trailing newline survived or that a space did not become `%20`. That comparison
needs `just spike-mobile-probe-host` running.

MEASURED against the real app (bilibili 8.83.0), and it shapes N4:

- the shared text is `<title> https://b23.tv/xxxxxxx` — **no bvid**, and
  `EXTRA_TITLE` is empty, so the title is only a substring of the body. The add
  page identifies nothing until it expands the short link, which is a network
  round trip (`redirect: 'manual'`);
- **a favlist cannot be shared to us at all**: its 分享 button opens bilibili's
  own "post to your timeline" composer, never the system sheet. Only the video
  detail page reaches 更多 → the chooser. The paste box stays the only way in
  for favlists and collections;
- the payload is transient — `resetOnBackground` is the library default, and
  leaving the app clears both the hook's value and the native side. Whatever
  consumes it must do so on mount.

`performance.now()` here is `SystemClock.uptimeMillis()`: not zero at context
start, and it does **not** advance during deep sleep (measured: 81,892s against
a `/proc/uptime` of 130,488s, the gap being one night asleep). Deltas over
milliseconds — everything N0b-3 measured — are unaffected; "how long since X"
across a screen-off period cannot use it.

## Backup exclusion and the zero-write read (D16)

`just spike-mobile-backup-audit` checks three things, and the order is the
point: the **built APK's** merged manifest (everything earlier is an intention),
then the two rule files read out of its compiled resources (an attribute can
point at an empty file and still look right), then `bmgr`'s own answer — with a
control package that DOES allow backup in the same run, because "Backup is not
allowed" only means something if something else says "Success".

MEASURED:

- `android:allowBackup="false"` turns off **cloud backup only**. Device-to-device
  transfer on Android 12+ is governed by `<device-transfer>` in
  `dataExtractionRules`, which is why the plugin writes both sections;
- compiled manifest attributes are numeric ids (`@0x7f140002`) — resolving them
  through `aapt2 dump resources` is what proves they point at OUR files rather
  than expo-secure-store's;
- copy-then-open costs **75ms** on a 50MB library and **150ms** with a 4MB hot
  WAL (budget: 500ms), and the original's size and mtime are unchanged across
  all five rounds. The recovery lands on the copy — its WAL goes 4,128,272 → 0
  bytes while the original sits still;
- looking for `-wal`/`-shm` NEXT TO the copy afterwards always reports "nothing
  happened": closing the connection checkpoints and deletes them. Evidence has
  to be taken while it is observable.

## Standing obligation

Expo lives in the desktop workspace now. **After any `pnpm install` change,
re-run `just check` and `just test`** (criterion 13). The install that created
this directory added 341 packages and changed no existing resolution; that is a
fact about one install, not a guarantee about the next.

The spike consumes `@lark/core/portable` through its **dist**, so a change to
core's source is invisible here until `pnpm --filter @lark/core build` — the
`just spike-mobile-*` recipes do it, a bare Metro reload does not.

And one level worse (MEASURED, N0b-5b): **rebuilding core is not enough for a
release APK.** Gradle's bundle task hashes the app's own inputs, and core's dist
arrives through a workspace symlink outside them, so the task stays up to date
and the APK ships yesterday's core. It looks like a fix that did not work — the
panel even shows the OLD assertion text. `spike-mobile-android-release` deletes
`android/app/build/generated/assets/react/release` before building for exactly
this reason.
