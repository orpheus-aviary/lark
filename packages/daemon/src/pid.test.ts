import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@lark/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonAlreadyRunningError,
  PidFileCorruptError,
  acquireDaemonLock,
  readPid,
  removePid,
} from './pid.js';

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

describe('readPid', () => {
  it('returns null when there is no lock file', () => {
    expect(readPid()).toBeNull();
  });

  it('returns the pid of a live owner', () => {
    writePidFile(String(process.pid));
    expect(readPid()).toBe(process.pid);
  });

  it('removes a stale file and returns null', () => {
    writePidFile(String(DEAD_PID));
    expect(readPid()).toBeNull();
    expect(existsSync(paths.pidPath())).toBe(false);
  });

  it.each([
    ['an empty file', ''],
    ['whitespace', '   \n'],
    ['zero', '0'],
    ['one (kill(1) would signal init)', '1'],
    ['a negative number (kill would signal a process GROUP)', '-42'],
    ['a non-number', 'daemon'],
    ['a float', '12.5'],
    ['an unsafe integer', '99999999999999999999'],
  ])('rejects %s without deleting the file', (_label, content) => {
    writePidFile(content);
    expect(() => readPid()).toThrow(PidFileCorruptError);
    expect(existsSync(paths.pidPath())).toBe(true);
  });

  it('treats EPERM as alive — the pid belongs to someone else, do not steal it', () => {
    writePidFile(String(DEAD_PID));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    expect(readPid()).toBe(DEAD_PID);
    expect(existsSync(paths.pidPath())).toBe(true);
  });
});

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
