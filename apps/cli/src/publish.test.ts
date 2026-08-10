// What ships to npm, asserted against the built artifact (M7-5 / M7-6).
//
// These run over `dist-publish/` when it is there and skip when it is not: a
// plain `just test` must not require a bundle, but `just pack-cli` and the
// release gate build one first, and then every claim below is checked against
// the real thing rather than against the config that was supposed to produce
// it.
//
// The reason this file exists at all: the repo's dependency guard greps
// SOURCE. It cannot see a bundler hoisting a dynamic import into the entry,
// which is exactly the failure M6-21 was built to prevent and exactly what a
// `noExternal: ['@lark/core']` invites.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import EXTERNALS from '../externals.json' with { type: 'json' };

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(CLI_DIR, 'dist-publish');
const built = existsSync(join(OUT, 'index.js'));

const read = (file: string): string => readFileSync(join(OUT, file), 'utf8');
const manifest = (): Record<string, unknown> =>
  JSON.parse(read('package.json')) as Record<string, unknown>;

/** Only the top-level `import ... from '<x>'` specifiers of a chunk. */
function staticImports(file: string): string[] {
  return [...read(file).matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
}

/** The entry plus everything it statically pulls in, transitively. */
function staticGraph(): string[] {
  const seen = new Set<string>(['index.js']);
  const queue = ['index.js'];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const specifier of staticImports(file)) {
      if (!specifier.startsWith('./')) continue;
      const name = specifier.slice(2);
      if (seen.has(name)) continue;
      seen.add(name);
      queue.push(name);
    }
  }
  return [...seen];
}

describe.skipIf(!built)('the published bundle', () => {
  // THE criterion. `lark status` has to work under a runtime whose ABI the
  // native binding was not built for, which it can only do if better-sqlite3
  // is never reached from the entry's static graph.
  it('keeps better-sqlite3 out of the entry chunk and everything it statically imports', () => {
    for (const file of staticGraph()) {
      const offenders = staticImports(file).filter((s) => s === 'better-sqlite3');
      expect(offenders, `${file} statically imports better-sqlite3`).toEqual([]);
    }
  });

  // The barrel is 176KB of core, and it is where better-sqlite3 lives. It has
  // to be a chunk nothing loads until `--direct` asks for it.
  it('leaves the core barrel in a chunk of its own', () => {
    const graph = new Set(staticGraph());
    const barrels = readdirSync(OUT).filter(
      (f) => f.endsWith('.js') && f !== 'index.js' && read(f).includes("from 'better-sqlite3'"),
    );
    expect(barrels.length, 'no chunk imports better-sqlite3 at all').toBeGreaterThan(0);
    for (const chunk of barrels) {
      expect(graph.has(chunk), `${chunk} is reachable from the entry statically`).toBe(false);
    }
  });

  it('declares exactly the externals the bundle left unresolved', () => {
    const declared = Object.keys(manifest().dependencies as Record<string, string>);
    expect(declared).toEqual([...EXTERNALS].sort());
  });

  it('pins every dependency exactly and carries no workspace protocol', () => {
    for (const [name, range] of Object.entries(manifest().dependencies as Record<string, string>)) {
      expect(range, `${name} is not an exact version`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('refuses to install where it cannot work', () => {
    expect(manifest().os).toEqual(['darwin']);
    expect(manifest().cpu).toEqual(['arm64']);
    expect(manifest().engines).toEqual({ node: '>=24' });
  });

  it('ships both bin names, pointed at the bundle entry', () => {
    expect(manifest().bin).toEqual({ lark: 'index.js', 'lark-cli': 'index.js' });
  });

  // A second shebang is not a comment: node reads `#!/usr/bin/env node` on
  // line 1 and the second one is a syntax error waiting for the first person
  // who runs the binary rather than `node` it.
  it('starts with exactly one shebang', () => {
    const lines = read('index.js').split('\n');
    expect(lines[0]).toBe('#!/usr/bin/env node');
    expect(lines.slice(1).filter((l) => l.startsWith('#!'))).toEqual([]);
  });

  it('leaves no stray files in the publish directory', () => {
    const unexpected = readdirSync(OUT).filter(
      (f) =>
        !/\.js$/.test(f) &&
        !/\.js\.map$/.test(f) &&
        !['package.json', 'LICENSE', 'README.md'].includes(f),
    );
    expect(unexpected).toEqual([]);
  });

  it('carries the licence and the readme it promises', () => {
    for (const file of ['LICENSE', 'README.md']) {
      expect(existsSync(join(OUT, file)), `${file} is missing from dist-publish`).toBe(true);
    }
  });
});
