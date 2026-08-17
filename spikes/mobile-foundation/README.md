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

- `index.ts` / `src/App.tsx` — the judgement panel. N0b-1 renders boot probes;
  later batches hang their panels off the same shell.
- `src/probes.ts` — what criterion 12 actually proves: each entry USES something
  from one of the three allowed packages, so a resolution failure is a bundling
  failure rather than a wrong number on screen.
- `app.config.ts` — the whole native configuration (CNG). `android/` is
  generated and untracked; anything that can only be said by hand-editing it
  belongs in a config plugin.
- `metro.config.js` — monorepo roots, with hierarchical lookup disabled so a
  package that resolves only by accident of hoisting fails here, not on a phone.

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
