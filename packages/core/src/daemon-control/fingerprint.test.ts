import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isNestFingerprint, nestFingerprint, realpathMissingOk } from './fingerprint.js';

describe('nestFingerprint', () => {
  // FIXED VECTORS. The daemon publishes this hash and every client compares
  // against its own computation, so the encoding is a wire format: if someone
  // "cleans up" the input (trims a trailing slash, lowercases, hashes bytes of
  // a different encoding), identity resolution silently starts answering
  // "another nest" for the daemon on the same machine. These pin it.
  it.each([
    [
      '/Users/someone/orpheus-aviary-nest/lark',
      '22778005948f72051eea5ca40982840e85579af26836fce09621cb11e3af1a45',
    ],
    ['/', '8a5edab282632443219e051e4ade2d1d5bbc671c781051bf1437897cbdfea0f1'],
  ])('hashes %s stably', (path, expected) => {
    expect(nestFingerprint(path)).toBe(expected);
  });

  it('produces 64 lowercase hex characters', () => {
    const fingerprint = nestFingerprint('/tmp/whatever');
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(isNestFingerprint(fingerprint)).toBe(true);
  });

  it('separates paths that differ only by a trailing slash', () => {
    // Not a bug to fix here: callers must resolve before hashing, and
    // `realpathMissingOk` never returns a trailing slash. Asserted so nobody
    // "fixes" it by normalising inside the hash instead of at the caller.
    expect(nestFingerprint('/a/b')).not.toBe(nestFingerprint('/a/b/'));
  });

  it.each([
    ['not hex', 'zz'.repeat(32)],
    ['uppercase', 'A'.repeat(64)],
    ['too short', 'a'.repeat(63)],
    ['empty', ''],
  ])('rejects a %s fingerprint', (_label, value) => {
    expect(isNestFingerprint(value)).toBe(false);
  });
});

describe('realpathMissingOk', () => {
  let root: string;

  const withTemp = (fn: (root: string) => void): void => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'lark-realpath-')));
    try {
      fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('resolves an existing path like realpath', () => {
    withTemp((dir) => {
      expect(realpathMissingOk(dir)).toBe(realpathSync(dir));
    });
  });

  it('follows symlinks on the existing prefix', () => {
    withTemp((dir) => {
      const real = join(dir, 'real');
      const link = join(dir, 'link');
      mkdirSync(real);
      symlinkSync(real, link);
      expect(realpathMissingOk(join(link, 'lark'))).toBe(join(real, 'lark'));
    });
  });

  it('re-appends every missing segment', () => {
    withTemp((dir) => {
      // The case that matters: a CLI writing to a fresh nest hashes the path
      // BEFORE the directory exists, and the daemon hashes it after — the two
      // must agree, or the first write to a new nest reads as "another nest".
      const missing = join(dir, 'orpheus-aviary-nest', 'lark');
      const beforeCreation = realpathMissingOk(missing);
      mkdirSync(missing, { recursive: true });
      expect(beforeCreation).toBe(realpathSync(missing));
    });
  });
});
