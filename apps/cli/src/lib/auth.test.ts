import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { daemonAuthHeaders } from './auth.js';

let dir: string;
const tokenPath = (): string => join(dir, 'daemon-token');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-auth-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('daemonAuthHeaders', () => {
  it('reads the token file every time it is called', () => {
    // R29: the daemon mints a fresh token on every boot, so a value cached at
    // startup turns a restart mid-command into an unexplainable 401.
    writeFileSync(tokenPath(), 'first-token');
    expect(daemonAuthHeaders(tokenPath())).toEqual({ Authorization: 'Bearer first-token' });

    writeFileSync(tokenPath(), 'rotated-token');
    expect(daemonAuthHeaders(tokenPath())).toEqual({ Authorization: 'Bearer rotated-token' });
  });

  it('trims the trailing newline the publisher may leave', () => {
    writeFileSync(tokenPath(), 'padded-token\n');
    expect(daemonAuthHeaders(tokenPath())).toEqual({ Authorization: 'Bearer padded-token' });
  });

  it.each([
    ['a missing file', undefined],
    ['an empty file', ''],
    ['a whitespace-only file', '   \n'],
  ])('answers with no header for %s', (_label, contents) => {
    // "No token" is a state identity resolution reasons about, not an error to
    // throw: an absent token is what a nest with no daemon history looks like.
    if (contents !== undefined) writeFileSync(tokenPath(), contents);
    expect(daemonAuthHeaders(tokenPath())).toEqual({});
  });

  it('answers with no header for an unreadable file', () => {
    writeFileSync(tokenPath(), 'secret');
    chmodSync(tokenPath(), 0o000);
    try {
      expect(daemonAuthHeaders(tokenPath())).toEqual({});
    } finally {
      chmodSync(tokenPath(), 0o600);
    }
  });
});
