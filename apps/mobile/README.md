# @lark/mobile

lark for Android. Expo SDK 57 + CNG, Android only. Phase B, subplan
`docs/plans/2026-08-19-phase-b-mobile-n2.md`.

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

Not here yet, and each arrives with its batch: `expo-audio` (N3),
`expo-share-intent` / `expo-linking` (N4).

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

`android/` is generated and untracked. Anything that can only be expressed by
hand-editing it belongs in `app.config.ts` or in `plugins/`.

## The spike is still alive

`spikes/mobile-foundation/` keeps the platform probes and the host-side driving
scripts (decision d). Its shim and this app's will drift; the contract is the
only truth, so both run DatabaseContract. Its applicationId
(`com.orpheusaviary.lark.spike`) is deliberately different from this one —
sharing it would have the first real install inherit the spike's data
directory.
