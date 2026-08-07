// The five-step stop protocol (M2-3, now shared by both CLIs — M6-9).
//
// Every refusal branch is worth a test for the same reason it exists: the pid
// file is not proof of identity, and signalling the wrong process is not an
// error you get to take back.

import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as paths from '../paths.js';
import { PidFileCorruptError } from './pid.js';
import { probeStatus, statusPid, stopDaemonVerified } from './stop.js';

let nest: string;
const DEAD_PID = 999999;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-stop-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  mkdirSync(paths.larkDir(), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

const writePid = (pid: number | string): void => writeFileSync(paths.pidPath(), String(pid));

/** A fetch that answers `/status` with `data`, or refuses the connection. */
function statusFetch(data: unknown | null): typeof fetch {
  return (async () => {
    if (data === null) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('probeStatus', () => {
  it('hands back the envelope data unvalidated', async () => {
    // Identity resolution has to tell a well-formed M6 answer from a pre-M6
    // one and from a malformed one (M6-19); a parser that normalised here
    // would erase the distinction.
    const probe = await probeStatus({ fetchImpl: statusFetch({ pid: 7, weird: true }) });
    expect(probe).toEqual({ kind: 'answered', data: { pid: 7, weird: true } });
  });

  it('reports a refused connection as unreachable', async () => {
    expect(await probeStatus({ fetchImpl: statusFetch(null) })).toEqual({ kind: 'unreachable' });
  });

  it('reports a non-lark answer as unreachable', async () => {
    const fetchImpl = (async () =>
      new Response('<html>hello</html>', { status: 200 })) as unknown as typeof fetch;
    expect(await probeStatus({ fetchImpl })).toEqual({ kind: 'unreachable' });
  });
});

describe('statusPid', () => {
  it.each([
    ['a plain object without pid', {}],
    ['a string', 'nope'],
    ['null', null],
    ['pid 0 (kill would signal the process group)', { pid: 0 }],
    ['a negative pid', { pid: -1 }],
    ['a float', { pid: 12.5 }],
  ])('returns null for %s', (_label, data) => {
    expect(statusPid(data)).toBeNull();
  });

  it('returns a plausible pid', () => {
    expect(statusPid({ pid: 4242 })).toBe(4242);
  });
});

describe('stopDaemonVerified', () => {
  it('is a no-op success when nothing is running', async () => {
    expect(await stopDaemonVerified()).toEqual({ kind: 'not-running' });
  });

  it('throws on a corrupt pid file rather than guessing', async () => {
    writePid('daemon');
    await expect(stopDaemonVerified()).rejects.toBeInstanceOf(PidFileCorruptError);
  });

  it('treats a stale pid file as nothing to stop', async () => {
    writePid(DEAD_PID);
    expect(await stopDaemonVerified()).toEqual({ kind: 'not-running' });
  });

  it('refuses to signal a live pid that cannot prove it is the daemon', async () => {
    writePid(process.pid); // alive, and definitely not a lark daemon
    const killImpl = vi.fn();

    const outcome = await stopDaemonVerified({ fetchImpl: statusFetch(null), killImpl });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'unverifiable', pid: process.pid });
    expect(killImpl).not.toHaveBeenCalled();
    expect(existsSync(paths.pidPath())).toBe(true);
  });

  it('refuses when /status names a different process', async () => {
    writePid(process.pid);
    const killImpl = vi.fn();

    const outcome = await stopDaemonVerified({
      fetchImpl: statusFetch({ pid: process.pid + 1 }),
      killImpl,
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'pid-mismatch' });
    expect(killImpl).not.toHaveBeenCalled();
  });

  it('signals a verified daemon and waits for it to be gone', async () => {
    writePid(process.pid);
    // The daemon's own teardown removes the pid file last; that is the signal
    // this protocol waits for, rather than reporting success on delivery.
    const killImpl = vi.fn(() => unlinkSync(paths.pidPath()));

    const outcome = await stopDaemonVerified({
      fetchImpl: statusFetch({ pid: process.pid }),
      killImpl,
      pollMs: 10,
    });

    expect(outcome).toEqual({ kind: 'stopped', pid: process.pid });
    expect(killImpl).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  it('reports a timeout when the process outlives the budget', async () => {
    writePid(process.pid);

    const outcome = await stopDaemonVerified({
      fetchImpl: statusFetch({ pid: process.pid }),
      killImpl: () => {}, // delivered, ignored
      pollMs: 10,
      stopTimeoutMs: 60,
    });

    expect(outcome).toMatchObject({ kind: 'timeout', pid: process.pid, waitedMs: 60 });
  });
});
