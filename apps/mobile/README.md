# @lark/mobile

lark for Android. Expo SDK 57 + CNG, Android only. Phase B — the master plan
is `docs/plans/2026-08-13-m4a-and-mobile-master-plan.md` §4 and every batch has
its own subplan in `docs/plans/`; which batch this app is on is recorded in
`PROCESS.md`, not here, because a README that tracks progress is a README that
is wrong.

## What this links

Of our own packages, exactly three: `@lark/core/portable`, `@lark/shared`, and
the skybridge SDK. `scripts/check-mobile-imports.sh` enforces it and
`scripts/check-portable-bundles.mjs` checks the graph Metro actually builds —
the rg guard reads source, the smoke reads the bundle, and only the second one
catches a dependency reaching for `node:fs` from inside its own package.

Four dependencies here are not ours to import directly: `drizzle-orm`,
`@noble/hashes`, `@orpheus-aviary/skybridge-client` and `-proto` belong to
`@lark/core`. They are declared anyway, and the reason is worth stating because
it is not "otherwise it breaks": the repo runs `node-linker=hoisted`, so an
undeclared dependency resolves perfectly well from the workspace root. That is
exactly the problem. `metro.config.js` sets `disableHierarchicalLookup` and
pins resolution to this package plus the root, and declaring what
`packages/core/dist/**` needs makes that resolution intentional rather than a
side effect of what someone else happened to install. The spike does the same.

## Versions

react / react-native / expo-\* are byte-identical to
`spikes/mobile-foundation/package.json` (criterion 2). The React Native version
comes from Expo's `bundledNativeModules.json`, never from npm latest. When a
version moves, it moves in both.

A dependency arrives with the batch that needs it and not before: `expo-audio`
came with N3, the three self-built native modules with N3e / N4b / N4c, and
`expo-share-intent` / `expo-linking` are N4d's. Every arrival re-runs the
DESKTOP's `just check` and `just test` — a phone dependency that disturbs the
workspace is a thing that has happened.

## Commands

```
just mobile-typecheck          # types only — not in the root `tsc -b`
just mobile-bundle-smoke       # does the portable graph resolve under Metro?
just mobile-prebuild           # regenerate android/ from app.config.ts
just mobile-android            # debug build + dev client + Metro
just mobile-android-release    # the build every NUMERIC criterion is measured on
just mobile-drive <args>       # press buttons on the device (spike's driver, retargeted)
just mobile-backup-audit       # D16's backup-exclusion evidence, on the built apk
```

The full set — the acceptance artifact, the fixture pushes, the driven library
run, the instrumentation — is in the `justfile` under the `mobile` group. It
grows every batch, so listing it twice would only teach you to trust the copy
that rots.

`android/` is generated and untracked. Anything that can only be expressed by
hand-editing it belongs in `app.config.ts` or in `plugins/`.

## The spike is still alive

`spikes/mobile-foundation/` keeps the platform probes and the host-side driving
scripts (decision d). Its shim and this app's will drift; the contract is the
only truth, so both run DatabaseContract. Its applicationId
(`com.orpheusaviary.lark.spike`) is deliberately different from this one —
sharing it would have the first real install inherit the spike's data
directory.
