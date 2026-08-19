#!/usr/bin/env node
// Does `@lark/core/portable` RESOLVE under Metro? (N1a criterion 19; widened
// to `apps/mobile` in N2a, criterion 4.)
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
// builds core first: these packages consume core through `dist`, so a portable
// source file is invisible here until it is compiled (N0b-5b — the same trap
// once shipped an APK carrying yesterday's core).
//
// TWO targets, because they can fail independently: the spike and the product
// app have their own `package.json` and their own `metro.config.js`, and with
// `disableHierarchicalLookup` a dependency declared by one is not resolvable
// from the other. One of them going green says nothing about the other.
//
// A failure here is not a test failure. It is a module that does not exist on
// the target platform, which fails at bundle time in a batch about something
// else entirely — which is exactly what this is for.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TARGETS = [
  { name: 'apps/mobile', filter: '@lark/mobile' },
  { name: 'spikes/mobile-foundation', filter: '@lark/spike-mobile-foundation' },
];

// Only run one of them: `node scripts/check-portable-bundles.mjs apps/mobile`.
const only = process.argv[2];
const targets = only ? TARGETS.filter((t) => t.name === only || t.filter === only) : TARGETS;
if (targets.length === 0) {
  console.error(`✗ no such bundle target: ${only}`);
  console.error(`  known: ${TARGETS.map((t) => t.name).join(', ')}`);
  process.exit(1);
}

function fail(target, message, detail) {
  console.error(`✗ [${target.name}] ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

function smoke(target) {
  const out = mkdtempSync(join(tmpdir(), 'lark-portable-bundle-'));
  const bundlePath = join(out, 'index.android.bundle');
  const mapPath = join(out, 'index.android.bundle.map');

  try {
    const result = spawnSync(
      'pnpm',
      [
        '--filter',
        target.filter,
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
        target,
        'Metro could not bundle the portable module graph',
        (verdict >= 0 ? lines.slice(verdict, verdict + 40) : lines.slice(-40)).join('\n'),
      );
    }

    const size = statSync(bundlePath).size;
    if (size < 200_000) fail(target, `the bundle is only ${size} bytes — that is not the app`);

    const sources = JSON.parse(readFileSync(mapPath, 'utf8')).sources ?? [];
    const core = sources.filter((s) => s.includes('/core/dist/'));
    const portable = core.filter((s) => s.includes('/core/dist/portable/'));

    // Criterion 7, checked BEFORE the general rule so that it is the message
    // you get. `core/migration/` is the desktop's mp3 -> m4a machinery (ffmpeg,
    // backup-and-swap, the writer lock); `core/portable/migrations/` is the
    // schema chain and belongs here. One character apart, opposite verdicts.
    const mp3Migration = core.filter((s) => s.includes('/core/dist/migration/'));
    if (mp3Migration.length > 0) {
      fail(
        target,
        "the desktop's audio migration reached the mobile bundle",
        mp3Migration.map((s) => `  ${s.replace(/.*\/core\/dist\//, '@lark/core/')}`).join('\n'),
      );
    }

    // These may link portable and NOTHING else of core (N0b's sixth guard).
    // Checked here against the built graph as well as against the source,
    // because an export map or a stray re-export can put a module in the
    // bundle that no import names.
    const escapees = core.filter((s) => !s.includes('/core/dist/portable/'));
    if (escapees.length > 0) {
      fail(
        target,
        'non-portable core modules reached the mobile bundle',
        escapees.map((s) => `  ${s.replace(/.*\/core\/dist\//, '@lark/core/')}`).join('\n'),
      );
    }

    if (!portable.some((s) => s.endsWith('/core/dist/portable/index.js'))) {
      fail(target, 'the portable barrel is not in the bundle — this smoke proved nothing');
    }

    console.log(
      `✓ [${target.name}] portable bundles for Metro (${portable.length} modules, ${(size / 1024 / 1024).toFixed(1)}MB bundle)`,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

for (const target of targets) smoke(target);
