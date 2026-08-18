// The desktop FileSystemPort adapter (N1a, criterion 5).
//
// Two things are worth testing about an adapter this thin: that absence comes
// back as a value while everything else still throws, and that
// `writeTextAtomic` really is atomic. The second one is not a code review
// question — it is observable, so it is observed.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeFileSystem } from './node-fs.js';

const fs = nodeFileSystem();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-node-fs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('absence is a value, everything else throws', () => {
  it('reports a missing file as null / false rather than an error', async () => {
    const missing = join(dir, 'nope.lrc');
    expect(fs.statSync(missing)).toBeNull();
    expect(fs.unlinkSync(missing)).toBe(false);
    expect(await fs.readText(missing)).toBeNull();
    expect(await fs.unlink(missing)).toBe(false);
  });

  it('answers for a file that is there', async () => {
    const path = join(dir, 'lyrics.lrc');
    writeFileSync(path, '[00:01.00]一行\n', 'utf-8');
    expect(fs.statSync(path)).toEqual({ size: Buffer.byteLength('[00:01.00]一行\n', 'utf8') });
    expect(await fs.readText(path)).toBe('[00:01.00]一行\n');
    expect(await fs.unlink(path)).toBe(true);
    expect(fs.statSync(path)).toBeNull();
  });

  it('lets a non-ENOENT failure through untouched', async () => {
    // A directory where a file is expected: EISDIR / EPERM depending on the
    // call, and none of core's business to reinterpret.
    const asDir = join(dir, 'a-directory');
    mkdirSync(asDir);
    await expect(fs.readText(asDir)).rejects.toThrow();
    expect(() => fs.unlinkSync(asDir)).toThrow();
  });
});

describe('writeTextAtomic', () => {
  it('creates missing parent directories', async () => {
    const path = join(dir, 'songs', 'deep', 'lyrics.lrc');
    await fs.writeTextAtomic(path, 'hello');
    expect(readFileSync(path, 'utf-8')).toBe('hello');
  });

  it('never lets a reader see a partial file', async () => {
    // The contract, measured rather than asserted about: a 6MB replacement is
    // far past a single write() syscall, so a naive writeFile would be caught
    // mid-flight by the polling below. Every observation has to be entirely
    // the old content or entirely the new one.
    const path = join(dir, 'big.lrc');
    const oldText = 'a'.repeat(6_000_000);
    const newText = 'b'.repeat(6_000_000);
    writeFileSync(path, oldText, 'utf-8');

    const observations = new Set<string>();
    const observe = (): void => {
      const seen = readFileSync(path, 'utf-8');
      observations.add(`${seen.length}:${seen[0]}:${seen[seen.length - 1]}`);
    };

    const writing = fs.writeTextAtomic(path, newText);
    for (let i = 0; i < 400; i += 1) {
      observe();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await writing;
    observe();

    const legal = new Set(['6000000:a:a', '6000000:b:b']);
    expect([...observations].filter((seen) => !legal.has(seen))).toEqual([]);
    expect(readFileSync(path, 'utf-8')).toBe(newText);
  });

  it('writes its temp file as a SIBLING, so the replace is a rename', async () => {
    // Same directory is what makes the rename atomic — across filesystems it
    // degrades to a copy, which is exactly the truncation window above.
    const path = join(dir, 'sibling.lrc');
    writeFileSync(path, 'old', 'utf-8');

    let duringWrite: string[] = [];
    const writing = fs.writeTextAtomic(path, 'x'.repeat(4_000_000));
    for (let i = 0; i < 50 && duringWrite.length === 0; i += 1) {
      const entries = readdirSync(dir).filter((name) => name !== 'sibling.lrc');
      if (entries.length > 0) duringWrite = entries;
      await new Promise((resolve) => setImmediate(resolve));
    }
    await writing;

    expect(duringWrite).toHaveLength(1);
    expect(duringWrite[0]).toMatch(/^\..*\.tmp$/);
    expect(readdirSync(dir)).toEqual(['sibling.lrc']); // and it is gone afterwards
  });

  it('leaves the old content in place when the write fails', async () => {
    const path = join(dir, 'kept.lrc');
    writeFileSync(path, 'the good lyrics', 'utf-8');
    // The target is a directory's name — the rename fails, and the point is
    // that the failure does not take the previous file with it.
    const doomed = join(dir, 'kept.lrc', 'nested.lrc');
    await expect(fs.writeTextAtomic(doomed, 'nonsense')).rejects.toThrow();
    expect(readFileSync(path, 'utf-8')).toBe('the good lyrics');
  });
});
