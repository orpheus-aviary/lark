import type { StopOutcome } from '@lark/core/daemon-control';
import { describe, expect, it } from 'vitest';
import type { CliError } from '../lib/errors.js';
import { captureStreams } from '../lib/output.js';
import { FakeChild, fakeSpawn, virtualClock } from '../testing/fake-child.js';
import { type FakeIdentity, fakeIdentity, identities } from '../testing/fake-identity.js';
import { type DaemonCommandDeps, runDaemonStart, runStopDaemon } from './daemon.js';

interface Harness extends DaemonCommandDeps {
  identity: FakeIdentity;
  streams: ReturnType<typeof captureStreams>;
}

function harness(identity: FakeIdentity, json = false): Harness {
  return { identity, streams: captureStreams(), json };
}

async function caught(fn: () => Promise<unknown>): Promise<CliError | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as CliError;
  }
}

const stopper = (outcome: StopOutcome): { calls: number; stop: () => Promise<StopOutcome> } => {
  const state = { calls: 0, stop: () => Promise.resolve(outcome) };
  return {
    get calls() {
      return state.calls;
    },
    stop: () => {
      state.calls += 1;
      return state.stop();
    },
  };
};

describe('lark daemon', () => {
  it('is idempotent: an already-running daemon is a success, not an error', async () => {
    const deps = harness(fakeIdentity([identities.current(321)]));
    await runDaemonStart(deps);

    expect(deps.streams.stdout).toEqual(['✓ daemon 已经在运行（pid 321）']);
    expect(deps.streams.stderr).toEqual([]);
  });

  it('reports {started, pid} under --json', async () => {
    const deps = harness(fakeIdentity([identities.current(321)]), true);
    await runDaemonStart(deps);

    expect(JSON.parse(deps.streams.stdout[0] as string)).toEqual({
      success: true,
      data: { started: false, pid: 321 },
      message: 'daemon already running',
    });
  });

  it('starts one when the port is free', async () => {
    const spawn = fakeSpawn(new FakeChild({ pid: 777 }));
    const deps = harness(fakeIdentity([identities.absent, identities.current(777)]));
    await runDaemonStart(deps, {
      ...virtualClock(),
      spawnImpl: spawn.impl,
      probeAbi: () => Promise.resolve({ ok: true }),
      command: () => ({ command: 'node', args: ['daemon.js'] }),
      spawnWaitMs: 100,
      pollMs: 10,
    });

    expect(deps.streams.stdout).toEqual(['✓ daemon 已启动（pid 777）']);
  });

  it("refuses next to another nest's daemon", async () => {
    const deps = harness(fakeIdentity([identities.otherNest()]));
    expect((await caught(() => runDaemonStart(deps)))?.code).toBe('DAEMON_OTHER_NEST');
  });
});

describe('lark stop-daemon', () => {
  it('is idempotent: nothing running is a success with a null pid', async () => {
    const deps = harness(fakeIdentity([identities.absent]));
    const stop = stopper({ kind: 'not-running' });
    await runStopDaemon(deps, { stop: stop.stop });

    expect(deps.streams.stdout).toEqual(['✓ daemon 本来就没在运行']);
    // Not even asked: the identity already answered.
    expect(stop.calls).toBe(0);
  });

  it('stops ours and reports the pid', async () => {
    const deps = harness(fakeIdentity([identities.current(42)]), true);
    await runStopDaemon(deps, { stop: stopper({ kind: 'stopped', pid: 42 }).stop });

    expect(JSON.parse(deps.streams.stdout[0] as string).data).toEqual({ stopped: true, pid: 42 });
  });

  it('stops an incompatible daemon too — that is the way out of one', async () => {
    // The five-step protocol never looks at the protocol version, and "stop
    // the old instance" is what every incompatible-daemon message says to do.
    const deps = harness(fakeIdentity([identities.incompatible(42)]));
    const stop = stopper({ kind: 'stopped', pid: 42 });
    await runStopDaemon(deps, { stop: stop.stop });

    expect(stop.calls).toBe(1);
    expect(deps.streams.stdout[0]).toContain('已停止');
  });

  it.each([
    ['another nest', identities.otherNest(), 'DAEMON_OTHER_NEST'],
    ['something unidentifiable', identities.unverifiable(), 'DAEMON_UNVERIFIED'],
  ])('never signals %s', async (_name, identity, code) => {
    const deps = harness(fakeIdentity([identity]));
    const stop = stopper({ kind: 'stopped', pid: 1 });

    expect((await caught(() => runStopDaemon(deps, { stop: stop.stop })))?.code).toBe(code);
    expect(stop.calls).toBe(0);
  });

  it("passes the protocol's own refusal through with its diagnosis", async () => {
    const deps = harness(fakeIdentity([identities.current(42)]));
    const err = await caught(() =>
      runStopDaemon(deps, {
        stop: stopper({
          kind: 'refused',
          pid: 42,
          reason: 'pid-mismatch',
          detail: 'pid file says 42, /status reports 43',
        }).stop,
      }),
    );

    expect(err?.code).toBe('DAEMON_UNVERIFIED');
    expect(err?.details).toEqual({ pid: 42, reason: 'pid-mismatch' });
  });

  it('reports a daemon that was signalled but is still alive', async () => {
    const deps = harness(fakeIdentity([identities.current(42)]));
    const err = await caught(() =>
      runStopDaemon(deps, { stop: stopper({ kind: 'timeout', pid: 42, waitedMs: 5000 }).stop }),
    );

    expect(err?.code).toBe('SHUTTING_DOWN');
    expect(err?.message).toContain('42');
  });

  it('turns a corrupt pid file into a refusal rather than an unknown error', async () => {
    const deps = harness(fakeIdentity([identities.current(42)]));
    const err = await caught(() =>
      runStopDaemon(deps, {
        stop: () => {
          const corrupt = new Error('pid file contains "nonsense"');
          corrupt.name = 'PidFileCorruptError';
          return Promise.reject(corrupt);
        },
      }),
    );

    expect(err?.code).toBe('DAEMON_UNVERIFIED');
  });
});
