// M4-2 branch matrix. Every refusal must (a) throw the right failure, (b)
// never spawn, and (c) never signal the foreign process — the assertions are
// as much about what does NOT happen as what does.

import { LOCAL_API_VERSION } from '@lark/daemon/version';
import { describe, expect, it } from 'vitest';
import {
  type DaemonChild,
  DaemonManager,
  type DaemonManagerDeps,
  DaemonStartError,
  type SpawnDaemonOptions,
} from './daemon-manager.js';

const BASE_URL = 'http://127.0.0.1:47100';
const REAL_LARK_DIR = '/real/nest/lark';
const TOKEN = 'token-abc';
const BASE_ENV = { PATH: '/usr/bin', LARK_NEST_DIR: '/real/nest' };

class FakeChild implements DaemonChild {
  pid: number | undefined = 4242;
  readonly kills: NodeJS.Signals[] = [];
  unrefed = false;
  exitOnSigterm = true;
  #exitListeners: Array<() => void> = [];
  exited = false;

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    if (signal === 'SIGKILL' || (signal === 'SIGTERM' && this.exitOnSigterm)) this.emitExit();
    return true;
  }

  unref(): void {
    this.unrefed = true;
  }

  once(event: 'exit', listener: () => void): void {
    if (event === 'exit') this.#exitListeners.push(listener);
  }

  on(_event: 'error', _listener: (err: Error) => void): void {}

  emitExit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.#exitListeners.splice(0)) listener();
  }
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data, message: '' }), { status: 200 });
}

function statusResponse(pid: number): Response {
  return envelope({ status: 'ok', pid, uptime: 1, version: '0.1.0' });
}

function instanceResponse(
  overrides: Partial<{ nest_dir: string; pid: number; local_api_version: number }> = {},
): Response {
  return envelope({
    nest_dir: REAL_LARK_DIR,
    pid: 999,
    version: '0.1.0',
    local_api_version: LOCAL_API_VERSION,
    ...overrides,
  });
}

const unreachable = (): Promise<Response> => Promise.reject(new TypeError('fetch failed'));

interface Upstream {
  status: () => Promise<Response> | Response;
  instance: (init?: RequestInit) => Promise<Response> | Response;
}

function harness(
  upstream: Partial<Upstream>,
  deps: Partial<DaemonManagerDeps> = {},
): {
  manager: DaemonManager;
  spawns: Array<{ command: string; args: string[]; options: SpawnDaemonOptions }>;
  instanceRequests: RequestInit[];
} {
  const spawns: Array<{ command: string; args: string[]; options: SpawnDaemonOptions }> = [];
  const instanceRequests: RequestInit[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${BASE_URL}/status`) {
      if (!upstream.status) throw new TypeError('fetch failed');
      return await upstream.status();
    }
    if (url === `${BASE_URL}/api/instance`) {
      if (init) instanceRequests.push(init);
      if (!upstream.instance) throw new TypeError('fetch failed');
      return await upstream.instance(init);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  // Every spawn is recorded here no matter which spawnImpl a test supplies.
  const innerSpawn = deps.spawnImpl;
  const recordingSpawn = (
    command: string,
    args: string[],
    options: SpawnDaemonOptions,
  ): DaemonChild => {
    spawns.push({ command, args, options });
    if (!innerSpawn) throw new Error('spawnImpl not configured for this test');
    return innerSpawn(command, args, options);
  };

  const manager = new DaemonManager({
    baseUrl: BASE_URL,
    realLarkDir: REAL_LARK_DIR,
    tokenPath: '/real/nest/lark/daemon-token',
    daemonCliPath: '/repo/packages/daemon/dist/cli.js',
    execPath: '/apps/Electron',
    env: { ...BASE_ENV },
    fetchImpl,
    readFileImpl: () => `${TOKEN}\n`,
    realpathImpl: (p) => p,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    spawnWaitMs: 200,
    spawnPollMs: 1,
    stopTimeoutMs: 50,
    stopPollMs: 1,
    ...deps,
    spawnImpl: recordingSpawn,
  });
  return { manager, spawns, instanceRequests };
}

async function startFailure(manager: DaemonManager): Promise<DaemonStartError> {
  try {
    await manager.start();
  } catch (err) {
    if (err instanceof DaemonStartError) return err;
    throw err;
  }
  throw new Error('start() unexpectedly succeeded');
}

describe('reuse path', () => {
  it('reuses a verified same-nest daemon and never claims ownership', async () => {
    const { manager, spawns, instanceRequests } = harness({
      status: () => statusResponse(999),
      instance: () => instanceResponse(),
    });
    const attachment = await manager.start();
    expect(attachment).toEqual({ kind: 'reused', pid: 999 });
    expect(manager.ownedPid).toBeNull();
    expect(spawns).toHaveLength(0);
    // The identity call authenticated with the freshly-read local token.
    const headers = instanceRequests[0]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // A reused daemon must never be stopped on exit.
    await manager.stop();
  });

  it('refuses on nest_dir mismatch (token copies included) without spawning', async () => {
    const { manager, spawns } = harness({
      status: () => statusResponse(999),
      instance: () => instanceResponse({ nest_dir: '/other/nest/lark' }),
    });
    expect((await startFailure(manager)).failure).toBe('nest-mismatch');
    expect(spawns).toHaveLength(0);
  });

  it('refuses on 401', async () => {
    const { manager, spawns } = harness({
      status: () => statusResponse(999),
      instance: () => new Response('{}', { status: 401 }),
    });
    expect((await startFailure(manager)).failure).toBe('auth-failed');
    expect(spawns).toHaveLength(0);
  });

  it('refuses on 404 — an M3-or-earlier daemon is a version gap, not an absence', async () => {
    const { manager, spawns } = harness({
      status: () => statusResponse(999),
      instance: () => new Response('{}', { status: 404 }),
    });
    expect((await startFailure(manager)).failure).toBe('api-version-mismatch');
    expect(spawns).toHaveLength(0);
  });

  it('refuses on local_api_version mismatch', async () => {
    const { manager } = harness({
      status: () => statusResponse(999),
      instance: () => instanceResponse({ local_api_version: LOCAL_API_VERSION + 1 }),
    });
    expect((await startFailure(manager)).failure).toBe('api-version-mismatch');
  });

  it.each([
    ['network error', unreachable],
    ['500', () => new Response('{}', { status: 500 })],
    ['invalid JSON', () => new Response('garbage', { status: 200 })],
  ])('refuses as unverifiable on instance %s', async (_label, instance) => {
    const { manager, spawns } = harness({
      status: () => statusResponse(999),
      instance,
    });
    expect((await startFailure(manager)).failure).toBe('unverifiable');
    expect(spawns).toHaveLength(0);
  });

  it('refuses when the daemon is reachable but the local token file is unreadable', async () => {
    const { manager, spawns, instanceRequests } = harness(
      { status: () => statusResponse(999), instance: () => instanceResponse() },
      {
        readFileImpl: () => {
          throw new Error('ENOENT');
        },
      },
    );
    expect((await startFailure(manager)).failure).toBe('token-unreadable');
    expect(spawns).toHaveLength(0);
    expect(instanceRequests).toHaveLength(0);
  });

  it('refuses when the port answers HTTP but not as a lark daemon', async () => {
    const { manager, spawns } = harness({
      status: () => new Response('<html>hi</html>', { status: 200 }),
    });
    expect((await startFailure(manager)).failure).toBe('unverifiable');
    expect(spawns).toHaveLength(0);
  });
});

describe('spawn path', () => {
  it('spawns, confirms by pid, and owns the child — with a clean env', async () => {
    let child: FakeChild | null = null;
    const { manager, spawns } = harness(
      {
        status: () =>
          child === null || child.pid === undefined ? unreachable() : statusResponse(child.pid),
      },
      {
        spawnImpl: () => {
          child = new FakeChild();
          return child;
        },
      },
    );

    const attachment = await manager.start();
    expect(attachment).toEqual({ kind: 'owned', pid: 4242 });
    expect(manager.ownedPid).toBe(4242);
    expect(spawns).toHaveLength(1);

    const [call] = spawns;
    expect(call?.command).toBe('/apps/Electron');
    expect(call?.args).toEqual(['/repo/packages/daemon/dist/cli.js', 'daemon']);
    expect(call?.options.detached).toBe(true);
    expect(call?.options.stdio).toBe('ignore');
    // Env contract (owl regression guard): inherited env + ELECTRON_RUN_AS_NODE,
    // and NOTHING token-shaped — the daemon mints its own token (R29).
    expect(call?.options.env).toEqual({ ...BASE_ENV, ELECTRON_RUN_AS_NODE: '1' });
    const suspicious = Object.entries(call?.options.env ?? {}).filter(
      ([key, value]) => /token/i.test(key) || value === TOKEN,
    );
    expect(suspicious).toEqual([]);
    expect((child as FakeChild | null)?.unrefed).toBe(true);
  });

  it('recycles the child and fails on confirm timeout', async () => {
    let child: FakeChild | null = null;
    const { manager } = harness(
      { status: unreachable },
      {
        spawnWaitMs: 20,
        spawnImpl: () => {
          child = new FakeChild();
          child.exitOnSigterm = false; // stays alive so the recycle is observable
          return child;
        },
      },
    );
    expect((await startFailure(manager)).failure).toBe('confirm-timeout');
    expect((child as FakeChild | null)?.kills).toEqual(['SIGTERM']);
    expect(manager.ownedPid).toBeNull();
  });

  it('fails as spawn-failed when the child dies and no daemon ever appears', async () => {
    let child: FakeChild | null = null;
    const { manager } = harness(
      { status: unreachable },
      {
        spawnImpl: () => {
          child = new FakeChild();
          queueMicrotask(() => child?.emitExit());
          return child;
        },
      },
    );
    expect((await startFailure(manager)).failure).toBe('spawn-failed');
    // Already dead — nothing to signal.
    expect((child as FakeChild | null)?.kills).toEqual([]);
  });

  it('fails as spawn-failed when spawn itself throws', async () => {
    const { manager } = harness(
      { status: unreachable },
      {
        spawnImpl: () => {
          throw new Error('ENOENT');
        },
      },
    );
    expect((await startFailure(manager)).failure).toBe('spawn-failed');
  });

  it('on a startup race, recycles its own child and reuses the verified winner', async () => {
    let child: FakeChild | null = null;
    const { manager } = harness(
      {
        status: () => (child === null ? unreachable() : statusResponse(7777)),
        instance: () => instanceResponse({ pid: 7777 }),
      },
      {
        spawnImpl: () => {
          child = new FakeChild();
          return child;
        },
      },
    );
    const attachment = await manager.start();
    expect(attachment).toEqual({ kind: 'reused', pid: 7777 });
    expect((child as FakeChild | null)?.kills).toEqual(['SIGTERM']);
    expect(manager.ownedPid).toBeNull();
  });

  it('on a startup race against a foreign-nest winner, recycles and refuses', async () => {
    let child: FakeChild | null = null;
    const { manager } = harness(
      {
        status: () => (child === null ? unreachable() : statusResponse(7777)),
        instance: () => instanceResponse({ nest_dir: '/other/lark' }),
      },
      {
        spawnImpl: () => {
          child = new FakeChild();
          return child;
        },
      },
    );
    expect((await startFailure(manager)).failure).toBe('nest-mismatch');
    expect((child as FakeChild | null)?.kills).toEqual(['SIGTERM']);
  });
});

describe('ownership hygiene and stop', () => {
  /**
   * Boots into the owned state with a mutable /status: `state.statusPid` is
   * what the port answers with from now on (null = unreachable), so each test
   * can reshape the stop-time re-probe.
   */
  async function ownedHarness() {
    const child = new FakeChild();
    const state: { statusPid: number | null } = { statusPid: null };
    const { manager } = harness(
      {
        status: () => (state.statusPid === null ? unreachable() : statusResponse(state.statusPid)),
        instance: () => instanceResponse(),
      },
      {
        spawnImpl: () => {
          state.statusPid = 4242;
          return child;
        },
      },
    );
    await manager.start();
    expect(manager.ownedPid).toBe(4242);
    return { manager, child, state };
  }

  it('clears ownership when the owned child exits — stop then signals nothing', async () => {
    const { manager, child } = await ownedHarness();
    child.emitExit();
    expect(manager.ownedPid).toBeNull();
    await manager.stop();
    expect(child.kills).toEqual([]);
  });

  it('stop: re-proves pid over /status, then SIGTERM (no SIGKILL when it exits)', async () => {
    const { manager, child } = await ownedHarness();
    await manager.stop();
    expect(child.kills).toEqual(['SIGTERM']);
    expect(manager.ownedPid).toBeNull();
  });

  it('stop: refuses to signal when /status answers with a different pid', async () => {
    const { manager, child, state } = await ownedHarness();
    state.statusPid = 5555; // child died; the OS recycled its pid
    await manager.stop();
    expect(child.kills).toEqual([]);
    expect(manager.ownedPid).toBeNull();
  });

  it('stop: refuses to signal when /status is unreachable', async () => {
    const { manager, child, state } = await ownedHarness();
    state.statusPid = null; // daemon already gone
    await manager.stop();
    expect(child.kills).toEqual([]);
    expect(manager.ownedPid).toBeNull();
  });

  it('stop: escalates to SIGKILL when SIGTERM is ignored', async () => {
    const { manager, child } = await ownedHarness();
    child.exitOnSigterm = false;
    await manager.stop();
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
