import { describe, expect, it } from 'vitest';
import { FakeChild, type FakeSpawn, fakeSpawn, virtualClock } from '../testing/fake-child.js';
import { identities, fakeIdentity as scripted } from '../testing/fake-identity.js';
import { ensureDaemon } from './ensure-daemon.js';
import type { CliError } from './errors.js';
import type { DaemonIdentity } from './identity.js';

// ─── Harness ───────────────────────────────────────────

const { current, absent } = identities;
const booting = identities.booting();

const base = (spawn: FakeSpawn) => ({
  ...virtualClock(),
  spawnImpl: spawn.impl,
  probeAbi: () => Promise.resolve({ ok: true as const }),
  command: () => ({ command: 'node', args: ['daemon.js'] }),
  spawnWaitMs: 1000,
  pollMs: 100,
  termWaitMs: 5,
  killWaitMs: 5,
});

async function caught(fn: () => Promise<unknown>): Promise<CliError | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as CliError;
  }
}

// ─── Tests ─────────────────────────────────────────────

describe('a daemon that is already there', () => {
  it('is adopted without spawning anything', async () => {
    const spawn = fakeSpawn();
    const result = await ensureDaemon({ ...base(spawn), identity: scripted([current(99)]) });

    expect(result).toEqual({ started: false, pid: 99 });
    expect(spawn.children).toHaveLength(0);
  });

  it.each([
    [
      'other-nest',
      { state: 'other-nest', pid: 7, fingerprint: 'b'.repeat(64) },
      'DAEMON_OTHER_NEST',
    ],
    [
      'same-nest-incompatible',
      { state: 'same-nest-incompatible', pid: 7, remoteApiVersion: 2 },
      'DAEMON_INCOMPATIBLE',
    ],
    [
      'unverifiable',
      { state: 'occupied-unverifiable', reason: 'malformed-status', pid: null },
      'DAEMON_UNVERIFIED',
    ],
  ] as [string, DaemonIdentity, string][])(
    'refuses to start a second one next to %s, and spawns nothing',
    async (_name, identity, code) => {
      const spawn = fakeSpawn();
      const err = await caught(() =>
        ensureDaemon({ ...base(spawn), identity: scripted([identity]) }),
      );

      expect(err?.code).toBe(code);
      expect(err?.details?.identity).toBeDefined();
      expect(spawn.children).toHaveLength(0);
    },
  );
});

describe('a live pid that has not answered yet', () => {
  it('is re-probed rather than refused — that is what booting looks like', async () => {
    // The daemon writes its pid file BEFORE it listens, so this state is the
    // normal middle of a startup, not a stranger on the port.
    const spawn = fakeSpawn();
    const result = await ensureDaemon({
      ...base(spawn),
      identity: scripted([booting, booting, current(42)]),
    });

    expect(result).toEqual({ started: false, pid: 42 });
    expect(spawn.children).toHaveLength(0);
  });

  it('is refused once the budget runs out', async () => {
    const spawn = fakeSpawn();
    const err = await caught(() => ensureDaemon({ ...base(spawn), identity: scripted([booting]) }));

    expect(err?.code).toBe('DAEMON_UNVERIFIED');
    expect(spawn.children).toHaveLength(0);
  });
});

describe('spawning', () => {
  it('starts a detached child with no pipes, and confirms it by pid', async () => {
    const spawn = fakeSpawn(new FakeChild({ pid: 555 }));
    const result = await ensureDaemon({
      ...base(spawn),
      identity: scripted([absent, absent, current(555)]),
    });

    expect(result).toEqual({ started: true, pid: 555 });
    // `stdio: 'ignore'` is not cosmetic: Node's default is `pipe`, and
    // `unref()` does not release a pipe's hold on the parent's event loop —
    // the CLI would never exit (六轮④).
    expect(spawn.options[0]).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('refuses to spawn when the native module is built for the other runtime', async () => {
    const spawn = fakeSpawn();
    const err = await caught(() =>
      ensureDaemon({
        ...base(spawn),
        identity: scripted([absent]),
        probeAbi: () =>
          Promise.resolve({
            ok: false as const,
            reason: 'abi-mismatch' as const,
            detail: 'NODE_MODULE_VERSION 148 vs 137',
            cause: null,
          }),
      }),
    );

    expect(err?.code).toBe('ABI_MISMATCH');
    expect(spawn.children).toHaveLength(0);
  });

  it('reports a child that died immediately instead of waiting out the budget', async () => {
    const child = new FakeChild({ pid: 1 });
    const spawn = fakeSpawn(child, true);
    const err = await caught(() => ensureDaemon({ ...base(spawn), identity: scripted([absent]) }));

    // Both failures are exit 4; only the message tells the user which one to
    // go and look at.
    expect(err?.code).toBe('DAEMON_UNAVAILABLE');
    expect(err?.message).toContain('立刻退出');
    // Nothing to recycle — it is already gone.
    expect(child.signals).toEqual([]);
  });

  it('gives up when nothing comes up, and takes the child with it', async () => {
    const child = new FakeChild({ pid: 7 });
    const spawn = fakeSpawn(child);
    const err = await caught(() => ensureDaemon({ ...base(spawn), identity: scripted([absent]) }));

    expect(err?.code).toBe('DAEMON_UNAVAILABLE');
    expect(child.signals).toEqual(['SIGTERM']);
  });
});

describe('losing the race', () => {
  it('recycles our child and reports the winner as already running', async () => {
    // Another process won the pid lock. Its daemon has passed the full
    // five-state check, so it is perfectly usable — ours is the one that has
    // to go.
    const child = new FakeChild({ pid: 111 });
    const spawn = fakeSpawn(child);
    const result = await ensureDaemon({
      ...base(spawn),
      identity: scripted([absent, current(222)]),
    });

    expect(result).toEqual({ started: false, pid: 222 });
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL, and says so when even that does not land', async () => {
    const child = new FakeChild({ pid: 111, diesOn: [] });
    const spawn = fakeSpawn(child);
    const result = await ensureDaemon({
      ...base(spawn),
      identity: scripted([absent, current(222)]),
    });

    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    // The promise is bounded, not absolute: a child that survives SIGKILL is
    // reported with its pid rather than silently assumed dead (五轮⑧).
    expect(result.started).toBe(false);
    expect(result.note).toContain('111');
  });

  it('signals nothing when the child is already gone', async () => {
    const child = new FakeChild({ pid: 111, gone: true });
    const spawn = fakeSpawn(child);
    const result = await ensureDaemon({
      ...base(spawn),
      identity: scripted([absent, current(222)]),
    });

    expect(child.signals).toEqual(['SIGTERM']); // one attempt, answered ESRCH
    expect(result.note).toBeUndefined();
  });

  it('carries a failed cleanup into the error it was already reporting', async () => {
    const child = new FakeChild({ pid: 111, diesOn: [] });
    const spawn = fakeSpawn(child);
    const err = await caught(() =>
      ensureDaemon({
        ...base(spawn),
        identity: scripted([absent, { state: 'other-nest', pid: 9, fingerprint: null }]),
      }),
    );

    expect(err?.code).toBe('DAEMON_OTHER_NEST');
    expect(err?.message).toContain('111');
    expect(err?.details?.cleanup_failed).toBe(true);
  });
});
