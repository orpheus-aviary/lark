// Criterion 110 (N7c). Three properties, each with the failure it prevents:
// a reader never sees a torn file, only the owner may release, and a holder
// that died stops holding.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SWITCH_LOCK_TTL_MS,
  isSwitchLockActive,
  newSwitchLockNonce,
  readSwitchLock,
  releaseSwitchLock,
  switchInFlight,
  touchSwitchLock,
  writeSwitchLock,
} from './switch-lock.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-switch-lock-'));
  path = join(dir, 'workspace-switch.lock');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('taking and releasing', () => {
  it('records this process, and reads back what it wrote', () => {
    const nonce = newSwitchLockNonce();
    writeSwitchLock(nonce, path);
    const lock = readSwitchLock(path);
    expect(lock?.pid).toBe(process.pid);
    expect(lock?.nonce).toBe(nonce);
    expect(switchInFlight(path)).toBe(true);
  });

  it('leaves no residue — a backup must not find a half-written lock', () => {
    writeSwitchLock(newSwitchLockNonce(), path);
    expect(readdirSync(dir)).toEqual(['workspace-switch.lock']);
  });

  it('is gone after a release, and releasing twice is not an error', () => {
    const nonce = newSwitchLockNonce();
    writeSwitchLock(nonce, path);
    releaseSwitchLock(nonce, path);
    expect(readSwitchLock(path)).toBeNull();
    expect(switchInFlight(path)).toBe(false);
    releaseSwitchLock(nonce, path);
  });
});

describe('the owner token', () => {
  it('refuses a release from somebody who does not hold it', () => {
    const mine = newSwitchLockNonce();
    writeSwitchLock(mine, path);
    // The case this is really for: a run that crashed, whose successor now
    // holds the lock, retrying its own cleanup.
    releaseSwitchLock(newSwitchLockNonce(), path);
    expect(readSwitchLock(path)?.nonce).toBe(mine);
  });

  it('refuses a heartbeat from somebody who does not hold it', () => {
    vi.useFakeTimers();
    const mine = newSwitchLockNonce();
    writeSwitchLock(mine, path);
    const before = readSwitchLock(path)?.started_at;

    vi.advanceTimersByTime(10_000);
    touchSwitchLock(newSwitchLockNonce(), path);
    // Stamping a stranger's lock with our clock would keep it alive forever.
    expect(readSwitchLock(path)?.started_at).toBe(before);

    touchSwitchLock(mine, path);
    expect(readSwitchLock(path)?.started_at).toBeGreaterThan(before as number);
  });
});

describe('a holder that is not there any more', () => {
  const put = (lock: Record<string, unknown>) => writeFileSync(path, JSON.stringify(lock));

  it('is not holding anything — the pid is gone', () => {
    // pid 1 exists; a very large pid does not. `process.kill(pid, 0)` is the
    // only question this can ask, and it is the whole reason the pid is in the
    // file at all.
    put({ pid: 2 ** 30, started_at: Date.now(), nonce: 'n' });
    expect(switchInFlight(path)).toBe(false);
  });

  it('is not holding anything once the TTL runs out either', () => {
    // The pid-reuse case: this process is alive, so liveness alone would say
    // "held" forever.
    put({ pid: process.pid, started_at: Date.now() - SWITCH_LOCK_TTL_MS - 1, nonce: 'n' });
    expect(switchInFlight(path)).toBe(false);
  });

  it('still counts while it is being heartbeated', () => {
    put({ pid: process.pid, started_at: Date.now() - SWITCH_LOCK_TTL_MS + 5_000, nonce: 'n' });
    expect(switchInFlight(path)).toBe(true);
  });
});

describe('a file this build cannot read', () => {
  for (const [name, text] of Object.entries({
    missing: null,
    empty: '',
    'not json': '{pid: 1}',
    'not an object': '"held"',
    'no nonce': '{"pid":1,"started_at":1}',
    'an empty nonce': '{"pid":1,"started_at":1,"nonce":""}',
    'a pid that is not one': '{"pid":0,"started_at":1,"nonce":"n"}',
    'a float pid': '{"pid":1.5,"started_at":1,"nonce":"n"}',
  })) {
    it(`reads ${name} as "nobody is switching"`, () => {
      if (text !== null) writeFileSync(path, text);
      expect(readSwitchLock(path)).toBeNull();
      // The safe direction: an unreadable lock must not block every future
      // `--direct` run on this machine forever.
      expect(switchInFlight(path)).toBe(false);
    });
  }
});

describe('what a reader sees mid-write', () => {
  it('never a partial file — the write is a rename', () => {
    const nonce = newSwitchLockNonce();
    writeSwitchLock(nonce, path);
    const first = readFileSync(path, 'utf-8');
    touchSwitchLock(nonce, path);
    const second = readFileSync(path, 'utf-8');
    // Both are complete JSON. There is no spelling of this test that catches a
    // torn read directly; what it pins is that the file is replaced whole.
    expect(() => JSON.parse(first)).not.toThrow();
    expect(() => JSON.parse(second)).not.toThrow();
    expect(isSwitchLockActive(readSwitchLock(path))).toBe(true);
  });
});
