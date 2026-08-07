import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as paths from '../paths.js';
import { PidFileCorruptError, inspectPidReadonly, readPid } from './pid.js';

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

describe('inspectPidReadonly', () => {
  it('reports an absent file', () => {
    expect(inspectPidReadonly()).toEqual({ state: 'absent', pid: null });
  });

  it('reports a live owner', () => {
    writePidFile(String(process.pid)); // this test process is very much alive
    expect(inspectPidReadonly()).toEqual({ state: 'live', pid: process.pid });
  });

  it('reports a stale file WITHOUT removing it', () => {
    writePidFile(String(DEAD_PID));

    expect(inspectPidReadonly()).toEqual({ state: 'stale', pid: DEAD_PID });
    // The whole reason this function exists (M6-9): a CLI asking "is a daemon
    // running?" — possibly about a nest it does not own — must not delete
    // state as a side effect of looking.
    expect(existsSync(paths.pidPath())).toBe(true);
  });

  it('reports corruption as a state, not an exception', () => {
    writePidFile('daemon');
    expect(inspectPidReadonly()).toEqual({ state: 'corrupt', pid: null, raw: 'daemon' });
    expect(existsSync(paths.pidPath())).toBe(true);
  });

  it('treats EPERM as alive — the pid belongs to someone else', () => {
    writePidFile(String(DEAD_PID));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    expect(inspectPidReadonly()).toEqual({ state: 'live', pid: DEAD_PID });
  });

  it('accepts an explicit path', () => {
    const elsewhere = join(nest, 'other.pid');
    writeFileSync(elsewhere, String(process.pid));
    expect(inspectPidReadonly(elsewhere)).toEqual({ state: 'live', pid: process.pid });
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
