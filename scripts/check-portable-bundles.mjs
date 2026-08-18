#!/usr/bin/env node
// Does `@lark/core/portable` RESOLVE under Metro? (N1a, criterion 19.)
//
// The rg guard reads source and answers "did someone write a forbidden import
// here". This answers a different question — "does the module graph Metro
// actually builds resolve on a phone" — and only the second one catches:
//
//   a dependency of portable reaching for a Node builtin from inside its own
//   package, which no grep over our source will ever see;
//   a package whose export map resolves one way under `tsc` and another under
//   Metro (`react-native` / `browser` conditions);
//   a transitive import that arrives through `dist` rather than through src.
//
// That last one is why this bundles rather than typechecks, and why the recipe
// builds core first: the spike consumes core through `dist`, so a portable
// source file is invisible here until it is compiled (N0b-5b — the same trap
// once shipped an APK carrying yesterday's core).
//
// A failure here is not a test failure. It is a module that does not exist on
// the target platform, which fails at bundle time in a batch about something
// else entirely — which is exactly what this is for.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'lark-portable-bundle-'));
const bundlePath = join(out, 'index.android.bundle');
const mapPath = join(out, 'index.android.bundle.map');

function fail(message, detail) {
  console.error(`✗ ${message}`);
  if (detail) console.error(detail);
  rmSync(out, { recursive: true, force: true });
  process.exit(1);
}

try {
  const result = spawnSync(
    'pnpm',
    [
      '--filter',
      '@lark/spike-mobile-foundation',
      'exec',
      'expo',
      'export:embed',
      '--platform',
      'android',
      '--dev',
      'false',
      '--entry-file',
      'index.ts',
      '--bundle-output',
      bundlePath,
      '--sourcemap-output',
      mapPath,
      '--assets-dest',
      join(out, 'assets'),
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  if (result.status !== 0) {
    // Metro's resolution errors lead with the verdict ("Unable to resolve
    // module node:fs from …") and then print the whole import chain, which
    // names the portable file that reached for something that is not there.
    // Printing from the verdict rather than the tail keeps both.
    const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n');
    const verdict = lines.findIndex((line) => /Unable to resolve|Error:/.test(line));
    fail(
      'Metro could not bundle the portable module graph',
      (verdict >= 0 ? lines.slice(verdict, verdict + 40) : lines.slice(-40)).join('\n'),
    );
  }

  const size = statSync(bundlePath).size;
  if (size < 200_000) fail(`the bundle is only ${size} bytes — that is not the app`);

  const sources = JSON.parse(readFileSync(mapPath, 'utf8')).sources ?? [];
  const core = sources.filter((s) => s.includes('/core/dist/'));
  const portable = core.filter((s) => s.includes('/core/dist/portable/'));

  // The spike may link portable and NOTHING else of core (N0b's sixth guard).
  // Checked here against the built graph as well as against the source,
  // because an export map or a stray re-export can put a module in the bundle
  // that no import in the spike names.
  const escapees = core.filter((s) => !s.includes('/core/dist/portable/'));
  if (escapees.length > 0) {
    fail(
      'non-portable core modules reached the mobile bundle',
      escapees.map((s) => `  ${s.replace(/.*\/core\/dist\//, '@lark/core/')}`).join('\n'),
    );
  }

  if (!portable.some((s) => s.endsWith('/core/dist/portable/index.js'))) {
    fail('the portable barrel is not in the bundle — this smoke proved nothing');
  }

  console.log(
    `✓ portable bundles for Metro (${portable.length} modules, ${(size / 1024 / 1024).toFixed(1)}MB bundle)`,
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}
