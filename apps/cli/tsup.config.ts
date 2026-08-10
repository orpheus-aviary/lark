// The publishable CLI bundle (M7-5).
//
// `tsc` output stays in `dist/` for the workspace (`just cli`, the tests); the
// published package is built here into `dist-publish/`, so the two can never be
// confused for one another.
//
// THE ONE THING THIS CONFIG HAS TO GET RIGHT is M6-21's boundary. The CLI
// reaches `@lark/core` two different ways on purpose:
//
//   - zero-native subpaths (`paths` / `config` / `daemon-control` /
//     `native-probe`) statically, from every command;
//   - the barrel — which loads better-sqlite3 — DYNAMICALLY, on the `--direct`
//     branch and nowhere else.
//
// so that `lark status` works under a runtime whose ABI the native binding was
// not built for. Bundling core in (`noExternal`) is what makes the published
// package self-contained, and `splitting` is what preserves the boundary: the
// dynamic import has to land in its own chunk rather than being hoisted into
// the entry. The repo's dependency guard greps SOURCE and cannot see any of
// this, so `just cli-smoke` asserts it on the built artifact instead.
//
// No `banner`: `src/index.ts` already starts with a shebang, and adding one
// here produces two.
//
// `better-sqlite3` and the rest stay external — a native module cannot be
// bundled, and the others are ordinary runtime dependencies of the published
// package (`gen-publishable-manifest.mjs` copies exactly this list).

// `externals.json` rather than a constant here: `gen-publishable-manifest.mjs`
// turns the same list into the published package's `dependencies`, and a
// plain JSON file is the one shape both a TS config and a Node script can read
// without either importing the other.

import { defineConfig } from 'tsup';
import external from './externals.json' with { type: 'json' };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  bundle: true,
  splitting: true,
  noExternal: ['@lark/core', '@lark/shared'],
  external,
  outDir: 'dist-publish',
  clean: true,
  sourcemap: true,
  treeshake: true,
  onSuccess: 'node scripts/gen-publishable-manifest.mjs',
});
