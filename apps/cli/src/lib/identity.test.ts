// Identity resolution (M6-19). Every state is reachable here without a
// socket: the probe, the pid inspection and `/api/instance` are all injected.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PidInspection } from '@lark/core/daemon-control';
import { nestFingerprint, realpathMissingOk } from '@lark/core/daemon-control';
import { LOCAL_API_VERSION, type StatusData } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DaemonIdentity,
  type IdentityDeps,
  IdentityHandle,
  classifyStatus,
  identityDetails,
  resolveIdentity,
} from './identity.js';

let nest: string;
const LARK_DIR = (): string => join(nest, 'lark');
const PID_FILE = (): string => join(LARK_DIR(), 'daemon.pid');

const localFingerprint = (): string => nestFingerprint(realpathMissingOk(LARK_DIR()));

function statusBody(overrides: Partial<StatusData> = {}): StatusData {
  return {
    status: 'ok',
    pid: 4242,
    uptime: 1,
    version: '0.1.0',
    nest_fingerprint: localFingerprint(),
    local_api_version: LOCAL_API_VERSION,
    ...overrides,
  };
}

/** `/api/instance` answering `status` with `body`. */
function instanceFetch(status: number, body?: Record<string, unknown>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ success: status === 200, data: body }), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

function deps(options: {
  status?: unknown | 'unreachable';
  instance?: typeof fetch;
  token?: string | null;
  pidState?: PidInspection['state'];
  pid?: number | null;
}): IdentityDeps {
  const {
    status = 'unreachable',
    instance = instanceFetch(200, {
      nest_dir: LARK_DIR(),
      pid: 4242,
      local_api_version: LOCAL_API_VERSION,
    }),
    token = 'test-token',
    pidState = 'absent',
    pid = null,
  } = options;

  return {
    probe: async () =>
      status === 'unreachable'
        ? ({ kind: 'unreachable' } as const)
        : ({ kind: 'answered', data: status } as const),
    fetchImpl: instance,
    authHeaders: (): Record<string, string> =>
      token === null ? {} : { Authorization: `Bearer ${token}` },
    inspectPid: (): PidInspection => ({ state: pidState, pid }),
    larkDirPath: LARK_DIR,
    pidFilePath: PID_FILE,
  };
}

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-identity-'));
  mkdirSync(LARK_DIR(), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(nest, { recursive: true, force: true });
});

describe('classifyStatus — the wire-format union', () => {
  it('accepts the M6 shape', () => {
    const shape = classifyStatus(statusBody());
    expect(shape.kind).toBe('current');
  });

  it('treats BOTH fields missing as a pre-M6 daemon', () => {
    const shape = classifyStatus({ status: 'ok', pid: 7, uptime: 1, version: '0.1.0' });
    expect(shape).toEqual({ kind: 'legacy', pid: 7 });
  });

  it.each([
    ['only the fingerprint', { nest_fingerprint: 'a'.repeat(64) }],
    ['only the version', { local_api_version: 3 }],
    ['an empty fingerprint', { nest_fingerprint: '', local_api_version: 3 }],
    ['an uppercase hash', { nest_fingerprint: 'A'.repeat(64), local_api_version: 3 }],
    ['a short hash', { nest_fingerprint: 'a'.repeat(63), local_api_version: 3 }],
    ['a zero version', { nest_fingerprint: 'a'.repeat(64), local_api_version: 0 }],
    ['a non-numeric version', { nest_fingerprint: 'a'.repeat(64), local_api_version: '3' }],
  ])('refuses to guess about %s', (_label, extra) => {
    // Half-set or malformed is NOT legacy: a daemon that publishes one field
    // and not the other is one nothing can be concluded about (M6-19).
    const shape = classifyStatus({ status: 'ok', pid: 7, uptime: 1, version: '0.1.0', ...extra });
    expect(shape.kind).toBe('invalid');
  });

  it.each([
    ['not an object', 'hello'],
    ['null', null],
  ])('refuses %s', (_label, body) => {
    expect(classifyStatus(body).kind).toBe('invalid');
  });
});

describe('resolveIdentity — nothing answers', () => {
  it('is absent with no pid file', async () => {
    expect(await resolveIdentity(deps({}))).toEqual({ state: 'absent' });
  });

  it('is absent with a stale pid file — and leaves it alone', async () => {
    writeFileSync(PID_FILE(), '999999');
    const identity = await resolveIdentity(deps({ pidState: 'stale', pid: 999999 }));

    expect(identity).toEqual({ state: 'absent' });
    // A read command does not tidy: the file is still there (M6-9).
    expect(existsSync(PID_FILE())).toBe(true);
  });

  it.each([
    ['live', 'pid-file-live'],
    ['corrupt', 'pid-file-corrupt'],
  ] as const)('is unverifiable when the pid file is %s', async (pidState, reason) => {
    const identity = await resolveIdentity(deps({ pidState, pid: 321 }));
    expect(identity).toEqual({ state: 'occupied-unverifiable', reason, pid: 321 });
  });
});

describe('resolveIdentity — the M6 shape', () => {
  it('is current when fingerprint, version, token and pid all agree', async () => {
    const identity = await resolveIdentity(deps({ status: statusBody() }));
    expect(identity).toMatchObject({ state: 'current', pid: 4242 });
  });

  it('is other-nest when the fingerprint differs — no token needed', async () => {
    const identity = await resolveIdentity(
      deps({ status: statusBody({ nest_fingerprint: 'b'.repeat(64) }), token: null }),
    );
    expect(identity).toMatchObject({ state: 'other-nest', pid: 4242 });
  });

  it('is same-nest-incompatible when only the protocol differs', async () => {
    const identity = await resolveIdentity(
      deps({ status: statusBody({ local_api_version: LOCAL_API_VERSION + 1 }) }),
    );
    expect(identity).toMatchObject({
      state: 'same-nest-incompatible',
      remoteApiVersion: LOCAL_API_VERSION + 1,
    });
  });

  // Criterion 32, named rather than derived: 5 is what 0.2.x answers, and a
  // 0.3.0 CLI cannot download through it — `naming_mode` is an unknown body
  // field there, and the refusal would arrive per request instead of once.
  it('refuses a 0.2.x daemon (protocol 5) on the same nest', async () => {
    const identity = await resolveIdentity(deps({ status: statusBody({ local_api_version: 5 }) }));
    expect(identity).toMatchObject({ state: 'same-nest-incompatible', remoteApiVersion: 5 });
    expect(LOCAL_API_VERSION).toBeGreaterThan(5);
  });

  it('is unverifiable when there is no readable token', async () => {
    const identity = await resolveIdentity(deps({ status: statusBody(), token: null }));
    expect(identity).toMatchObject({ state: 'occupied-unverifiable', reason: 'token-unreadable' });
  });

  it('is unverifiable when the token is rejected', async () => {
    const identity = await resolveIdentity(
      deps({ status: statusBody(), instance: instanceFetch(401) }),
    );
    expect(identity).toMatchObject({ state: 'occupied-unverifiable', reason: 'auth-failed' });
  });

  it('retries a pid disagreement, then refuses', async () => {
    // A daemon that restarts between `/status` and `/api/instance` produces
    // two pids; retrying re-reads BOTH, and a pid that keeps moving is not
    // something to hand a token to.
    const identity = await resolveIdentity(
      deps({
        status: statusBody(),
        instance: instanceFetch(200, {
          nest_dir: LARK_DIR(),
          pid: 9999,
          local_api_version: LOCAL_API_VERSION,
        }),
      }),
    );
    expect(identity).toMatchObject({ state: 'occupied-unverifiable', reason: 'pid-unstable' });
  });

  it('refuses when the authenticated answer contradicts the fingerprint', async () => {
    const identity = await resolveIdentity(
      deps({
        status: statusBody(),
        instance: instanceFetch(200, {
          nest_dir: join(nest, 'somewhere-else'),
          pid: 4242,
          local_api_version: LOCAL_API_VERSION,
        }),
      }),
    );
    expect(identity).toMatchObject({ state: 'occupied-unverifiable' });
  });

  it('matches a fresh nest whose directory does not exist yet', async () => {
    // `realpathMissingOk` is what makes the two sides agree before the daemon
    // has created the directory (M6-19): the CLI hashes the path it is about
    // to use, the daemon hashes it after creating it, and they must land on
    // the same string.
    const freshLark = join(nest, 'brand-new', 'lark');
    const identity = await resolveIdentity({
      ...deps({
        status: statusBody({ nest_fingerprint: nestFingerprint(realpathMissingOk(freshLark)) }),
        instance: instanceFetch(200, {
          nest_dir: freshLark,
          pid: 4242,
          local_api_version: LOCAL_API_VERSION,
        }),
      }),
      larkDirPath: () => freshLark,
    });
    expect(identity).toMatchObject({ state: 'current' });
  });
});

describe('resolveIdentity — a pre-M6 daemon', () => {
  const legacyStatus = { status: 'ok', pid: 7, uptime: 1, version: '0.1.0' };

  it('is same-nest-incompatible when it accepts our token', async () => {
    const identity = await resolveIdentity(
      deps({
        status: legacyStatus,
        instance: instanceFetch(200, { nest_dir: LARK_DIR(), pid: 7, local_api_version: 2 }),
      }),
    );
    expect(identity).toMatchObject({ state: 'same-nest-incompatible', remoteApiVersion: 2 });
  });

  it('is other-nest when it answers for a different directory', async () => {
    const identity = await resolveIdentity(
      deps({
        status: legacyStatus,
        instance: instanceFetch(200, { nest_dir: join(nest, 'elsewhere'), pid: 7 }),
      }),
    );
    expect(identity).toMatchObject({ state: 'other-nest', fingerprint: null });
  });

  it('is unverifiable when it rejects our token — an accepted boundary', async () => {
    // A foreign PRE-M6 daemon cannot be proven foreign: it publishes no
    // fingerprint and will not answer us. Fail closed (M6-19).
    const identity = await resolveIdentity(
      deps({ status: legacyStatus, instance: instanceFetch(401) }),
    );
    expect(identity).toMatchObject({ state: 'occupied-unverifiable', reason: 'auth-failed' });
  });
});

describe('IdentityHandle', () => {
  it('resolves once and caches', async () => {
    let probes = 0;
    const handle = new IdentityHandle({
      ...deps({}),
      probe: async () => {
        probes++;
        return { kind: 'unreachable' } as const;
      },
    });

    expect(await handle.resolve()).toEqual({ state: 'absent' });
    expect(await handle.resolve()).toEqual({ state: 'absent' });
    expect(probes).toBe(1);
  });

  it('re-probes on resolveFresh', async () => {
    let probes = 0;
    const handle = new IdentityHandle({
      ...deps({}),
      probe: async () => {
        probes++;
        return { kind: 'unreachable' } as const;
      },
    });

    await handle.resolve();
    await handle.resolveFresh();
    expect(probes).toBe(2);
  });
});

describe('identityDetails', () => {
  it('reports whether the fingerprint matched', () => {
    const other: DaemonIdentity = { state: 'other-nest', pid: 5, fingerprint: 'b'.repeat(64) };
    expect(identityDetails(other)).toMatchObject({ fingerprint_match: false, pid: 5 });

    const incompatible: DaemonIdentity = {
      state: 'same-nest-incompatible',
      pid: 5,
      remoteApiVersion: 2,
    };
    expect(identityDetails(incompatible)).toMatchObject({ fingerprint_match: true });
  });
});
