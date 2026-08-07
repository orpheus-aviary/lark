import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PidFileCorruptError, paths } from '@lark/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonAlreadyRunningError, acquireDaemonLock, removePid } from './pid.js';

/** A pid high enough that nothing owns it (the stale-file case). */
const DEAD_PID = 999999;

let nest: string;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-pid-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  mkdirSync(paths.larkDir(), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

const writePidFile = (content: string): void => writeFileSync(paths.pidPath(), content);

describe('acquireDaemonLock', () => {
  it('writes our pid into a fresh lock file', () => {
    acquireDaemonLock();
    expect(readFileSync(paths.pidPath(), 'utf-8')).toBe(String(process.pid));
  });

  it('refuses when a LIVE pid already holds the lock', () => {
    writePidFile(String(process.pid)); // this test process is very much alive
    expect(() => acquireDaemonLock()).toThrow(DaemonAlreadyRunningError);
  });

  it('takes over a stale lock file', () => {
    writePidFile(String(DEAD_PID));
    acquireDaemonLock();
    expect(readFileSync(paths.pidPath(), 'utf-8')).toBe(String(process.pid));
  });

  it('fails closed on a corrupt lock file instead of stealing the lock', () => {
    writePidFile('');
    expect(() => acquireDaemonLock()).toThrow(PidFileCorruptError);
    expect(existsSync(paths.pidPath())).toBe(true); // never deleted
  });
});

// The reader's own tests live with it, in
// `@lark/core/daemon-control` (M6-9) — what is left here is the write half.

describe('removePid', () => {
  it('removes the file when it still holds our pid', () => {
    writePidFile(String(process.pid));
    removePid();
    expect(existsSync(paths.pidPath())).toBe(false);
  });

  it("leaves another owner's file alone (a late teardown must not unlock a successor)", () => {
    writePidFile(String(DEAD_PID));
    removePid();
    expect(existsSync(paths.pidPath())).toBe(true);
  });

  it('is a no-op when the file is already gone', () => {
    expect(() => removePid()).not.toThrow();
  });
});
