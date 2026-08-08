import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTargetPath } from './target-path.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lark-target-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveTargetPath', () => {
  it('uses a file path as given', () => {
    const target = join(root, 'thing.md');
    expect(resolveTargetPath(target, 'default.md')).toBe(target);
  });

  it('appends the default name inside an existing directory', () => {
    mkdirSync(join(root, 'out'));
    expect(resolveTargetPath(join(root, 'out'), 'default.md')).toBe(join(root, 'out/default.md'));
  });

  it('treats a trailing slash as a directory even before it exists', () => {
    // T6 实测: without this, `-o ~/backup/` became a FILE named `backup` —
    // skill export blew up on the rename, playlist export would have written
    // the export under the directory's own name and looked fine.
    expect(resolveTargetPath(`${join(root, 'fresh')}/`, 'default.md')).toBe(
      join(root, 'fresh/default.md'),
    );
  });

  it('resolves a relative path against the CURRENT directory, not the nest', () => {
    expect(resolveTargetPath('./out.md', 'default.md')).toBe(resolve(process.cwd(), 'out.md'));
  });
});
