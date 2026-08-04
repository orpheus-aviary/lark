import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@lark/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateLocalToken, publishLocalToken } from './local-token.js';

let nest: string;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-token-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  mkdirSync(paths.larkDir(), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

describe('generateLocalToken', () => {
  it('produces a fresh 256-bit base64url token every call', () => {
    const a = generateLocalToken();
    const b = generateLocalToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe('publishLocalToken', () => {
  it('writes the token 0600 and leaves no temp behind', () => {
    const token = generateLocalToken();
    publishLocalToken(token);

    const path = paths.localTokenPath();
    expect(readFileSync(path, 'utf-8')).toBe(token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(paths.larkDir()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces an existing token atomically, keeping 0600', () => {
    publishLocalToken('old-token');
    const fresh = generateLocalToken();
    publishLocalToken(fresh);

    expect(readFileSync(paths.localTokenPath(), 'utf-8')).toBe(fresh);
    expect(statSync(paths.localTokenPath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(paths.larkDir()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('cleans up the temp file when the publish fails', () => {
    // A directory at the destination makes `rename` fail after the temp exists.
    mkdirSync(paths.localTokenPath(), { recursive: true });

    expect(() => publishLocalToken(generateLocalToken())).toThrow();
    expect(readdirSync(paths.larkDir()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
