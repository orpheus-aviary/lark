#!/usr/bin/env node
// The package.json that ships to npm (M7-6).
//
// GENERATED, never hand-edited, because the workspace manifest cannot be the
// published one: `@lark/cli` is private, its dependencies are `workspace:*`
// (meaningless outside this repo), and its `bin` points at the tsc output
// rather than the bundle.
//
// The dependency list is derived from ONE place — tsup's `external` — so the
// bundle and the manifest cannot drift: anything tsup left as an import has to
// be installable at the other end, and anything it inlined must NOT be
// declared (npm would download a package nobody imports). The workspace
// packages are excluded because they are bundled in and unpublished.
//
// Run by tsup's `onSuccess`, so `dist-publish/` is always complete.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(CLI_DIR, '../..');
const OUT_DIR = join(CLI_DIR, 'dist-publish');

const EXTERNAL = JSON.parse(readFileSync(join(CLI_DIR, 'externals.json'), 'utf8'));
const workspace = JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf8'));
const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** Where each external's version comes from: whichever workspace package declares it. */
const VERSION_SOURCES = ['apps/cli', 'packages/core', 'packages/shared'];

function versionOf(name) {
  for (const dir of VERSION_SOURCES) {
    const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
    const version = manifest.dependencies?.[name];
    if (version !== undefined && !version.startsWith('workspace:')) return version;
  }
  throw new Error(
    `${name} is external to the bundle but no workspace package declares a version for it`,
  );
}

const dependencies = Object.fromEntries(
  EXTERNAL.filter((name) => !name.startsWith('@lark/'))
    .sort()
    .map((name) => [name, versionOf(name)]),
);

const manifest = {
  name: '@orpheus-aviary/lark-cli',
  version: workspace.version,
  description: 'lark（百灵音乐）命令行客户端',
  license: root.license ?? 'MIT',
  type: 'module',
  // Both names on purpose: `lark` is what the docs and the skill file say, and
  // `lark-cli` is the escape hatch for anyone who already has a `lark` on PATH.
  bin: { lark: 'index.js', 'lark-cli': 'index.js' },
  files: ['*.js', '*.js.map', 'README.md', 'LICENSE'],
  dependencies,
  // The daemon and the GUI it can start are macOS arm64 only, and
  // better-sqlite3 would build for a platform that has nothing to run.
  os: ['darwin'],
  cpu: ['arm64'],
  engines: { node: '>=24' },
  repository: { type: 'git', url: 'git+https://github.com/orpheus-aviary/lark.git' },
};

writeFileSync(join(OUT_DIR, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

for (const file of ['LICENSE', 'README.md']) {
  const from = join(ROOT, file === 'README.md' ? 'apps/cli/README.md' : file);
  if (existsSync(from)) writeFileSync(join(OUT_DIR, file), readFileSync(from));
}

process.stdout.write(`[manifest] ${manifest.name}@${manifest.version} -> ${OUT_DIR}\n`);
