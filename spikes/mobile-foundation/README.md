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

1. **Of our own packages, this spike may import exactly three**:
   `@lark/core/portable`, `@lark/shared`, and the skybridge SDK
   (`@orpheus-aviary/skybridge-client` / `-proto`).
   `scripts/check-spike-mobile-imports.sh` enforces it and runs in `just check`.
   Third-party dependencies are out of that guard's scope by design.

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
- `src/panels/` — bootstrap rehearsal (15), contract driver (14), and the two
  drizzle probes (17a/17b) over a shared counting Proxy.
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

`adb` works, with two ways to accidentally leave the app: the dev menu closes on
ONE back press and exits on the second, and fast repeated swipes register as the
home gesture. Confirm the spike is foreground with `dumpsys activity activities`
before `screencap` — `pidof` says yes for a backgrounded app too.

Results also go to logcat (`CONTRACT`, `MATRIX`, `DRIZZLE` prefixes), which is
how to read a run without scrolling fifty rows on a phone.

## Running it

```
just spike-mobile-typecheck        # types only; not in the root tsc -b
just spike-mobile-prebuild         # regenerate android/ from app.config.ts
just spike-mobile-android          # debug build + install + Metro
just spike-mobile-android-release  # release build — REQUIRED for every numeric criterion
```

`JAVA_HOME` is pinned to Temurin 17 inside those recipes. It is deliberately not
exported globally: this machine's default is JDK 25, which the rest of the repo
is fine with and React Native's Gradle line is not.

Debug builds measure the debugger. §3.2a binds every numeric criterion to
release builds on the one frozen device recorded in the subplan's §9.

## Standing obligation

Expo lives in the desktop workspace now. **After any `pnpm install` change,
re-run `just check` and `just test`** (criterion 13). The install that created
this directory added 341 packages and changed no existing resolution; that is a
fact about one install, not a guarantee about the next.

The spike consumes `@lark/core/portable` through its **dist**, so a change to
core's source is invisible here until `pnpm --filter @lark/core build` — the
`just spike-mobile-*` recipes do it, a bare Metro reload does not.
