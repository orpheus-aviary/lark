import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureNestIdentity, nestDirFromAdditionalData } from './nest.js';

describe('ensureNestIdentity', () => {
  let tmp: string;

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('cold start: creates the whole chain when neither nest nor lark dir exists', () => {
    tmp = mkdtempSync(join(tmpdir(), 'lark-nest-'));
    // Two missing levels below an existing tmp dir — the empty-nest cold
    // start that made realpathSync throw ENOENT before the mkdir (M4-4).
    vi.stubEnv('LARK_NEST_DIR', join(tmp, 'does-not-exist', 'nest'));
    const { larkDirPath, realLarkDir } = ensureNestIdentity();
    expect(larkDirPath).toBe(join(tmp, 'does-not-exist', 'nest', 'lark'));
    expect(realLarkDir).toBe(realpathSync(larkDirPath));
  });

  it('resolves symlinked nests to one identity', () => {
    tmp = mkdtempSync(join(tmpdir(), 'lark-nest-'));
    vi.stubEnv('LARK_NEST_DIR', tmp);
    const { realLarkDir } = ensureNestIdentity();
    // macOS: /var → /private/var. The realpath'd form must be stable when
    // re-entered through its own symlinked spelling.
    vi.stubEnv('LARK_NEST_DIR', realpathSync(tmp));
    expect(ensureNestIdentity().realLarkDir).toBe(realLarkDir);
  });
});

describe('nestDirFromAdditionalData', () => {
  it('extracts nest_dir from a well-formed payload', () => {
    expect(nestDirFromAdditionalData({ nest_dir: '/a/lark' })).toBe('/a/lark');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'nope'],
    ['missing key', {}],
    ['non-string value', { nest_dir: 42 }],
  ])('reads %s as unknown, never throws', (_label, data) => {
    expect(nestDirFromAdditionalData(data)).toBeNull();
  });
});
