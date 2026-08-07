// The mode matrix (M6-2), enumerated. Five identity states × three needs ×
// `--direct`, plus the one cell that also consults the local pid file.
//
// Written as a table rather than as prose assertions: the point of a matrix is
// that you can see the cell you are about to change, and what its neighbours
// say.

import type { PidInspection } from '@lark/core/daemon-control';
import { LOCAL_API_VERSION, type StatusData } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import type { DaemonIdentity } from '../lib/identity.js';
import { type BackendNeed, type ModeDecision, decideMode } from './resolve.js';

const STATUS: StatusData = {
  status: 'ok',
  pid: 42,
  uptime: 1,
  version: '0.1.0',
  nest_fingerprint: 'a'.repeat(64),
  local_api_version: LOCAL_API_VERSION,
};

const IDENTITIES: Record<string, DaemonIdentity> = {
  absent: { state: 'absent' },
  current: { state: 'current', status: STATUS, pid: 42 },
  otherNest: { state: 'other-nest', pid: 42, fingerprint: 'b'.repeat(64) },
  incompatible: { state: 'same-nest-incompatible', pid: 42, remoteApiVersion: 2 },
  unverifiable: { state: 'occupied-unverifiable', reason: 'pid-file-live', pid: 42 },
};

const NO_PID: PidInspection = { state: 'absent', pid: null };
const LIVE_PID: PidInspection = { state: 'live', pid: 99 };

function mode(
  need: BackendNeed,
  identity: DaemonIdentity,
  direct: boolean,
  localPid: PidInspection = NO_PID,
  canLaunch = false,
): ModeDecision {
  return decideMode({ need, direct, identity, localPid, canLaunch });
}

/** `kind`, or `error:CODE` — one string per cell, so the tables stay readable. */
function cell(decision: ModeDecision): string {
  return decision.kind === 'error' ? `error:${decision.code}` : decision.kind;
}

describe('read', () => {
  it.each([
    ['absent', false, 'direct-read'],
    ['absent', true, 'direct-read'],
    ['current', false, 'http'],
    ['current', true, 'direct-read'],
    ['otherNest', false, 'direct-read'],
    ['otherNest', true, 'direct-read'],
    ['incompatible', false, 'direct-read'],
    ['unverifiable', false, 'direct-read'],
  ])('%s + direct=%s → %s', (key, direct, expected) => {
    // A read writes nothing, so it is safe in every state — including the ones
    // a write must refuse. That is the whole reason the read path exists.
    expect(cell(mode('read', IDENTITIES[key] as DaemonIdentity, direct))).toBe(expected);
  });

  it('says so on stderr when it reads around something it could not identify', () => {
    const decision = mode('read', IDENTITIES.unverifiable as DaemonIdentity, false);
    expect(decision).toMatchObject({ kind: 'direct-read' });
    expect((decision as { note?: string }).note).toBeDefined();
  });

  it('stays quiet in the ordinary "no daemon" case', () => {
    expect(
      (mode('read', IDENTITIES.absent as DaemonIdentity, false) as { note?: string }).note,
    ).toBeUndefined();
  });
});

describe('write', () => {
  it.each([
    // R31: while OUR daemon runs, a direct write is refused outright.
    ['current', false, 'http'],
    ['current', true, 'error:DAEMON_RUNNING_BLOCKED'],
    // No daemon: `--direct` must be SPELLED OUT. No silent downgrade.
    ['absent', false, 'error:DAEMON_UNAVAILABLE'],
    ['absent', true, 'direct-write'],
    // Another nest's daemon says nothing about our library.
    ['otherNest', false, 'error:DAEMON_UNAVAILABLE'],
    ['otherNest', true, 'direct-write'],
    // "Stop the old instance" — not "there is nothing here".
    ['incompatible', false, 'error:DAEMON_INCOMPATIBLE'],
    ['incompatible', true, 'error:DAEMON_INCOMPATIBLE'],
    ['unverifiable', false, 'error:DAEMON_UNVERIFIED'],
    ['unverifiable', true, 'error:DAEMON_UNVERIFIED'],
  ])('%s + direct=%s → %s', (key, direct, expected) => {
    expect(cell(mode('write', IDENTITIES[key] as DaemonIdentity, direct))).toBe(expected);
  });

  it('refuses an other-nest direct write while OUR pid file is live', () => {
    // The daemon on the port belongs to someone else, but a live local pid
    // means a daemon for THIS nest may be starting right now — and two writers
    // is exactly what the whole lock protocol exists to prevent.
    expect(cell(mode('write', IDENTITIES.otherNest as DaemonIdentity, true, LIVE_PID))).toBe(
      'error:DAEMON_UNVERIFIED',
    );
  });

  it('allows it when the local pid file is merely stale', () => {
    const stale: PidInspection = { state: 'stale', pid: 999999 };
    expect(cell(mode('write', IDENTITIES.otherNest as DaemonIdentity, true, stale))).toBe(
      'direct-write',
    );
  });
});

describe('daemon-required', () => {
  it.each([
    ['current', 'http'],
    ['otherNest', 'error:DAEMON_OTHER_NEST'],
    ['incompatible', 'error:DAEMON_INCOMPATIBLE'],
    ['unverifiable', 'error:DAEMON_UNVERIFIED'],
  ])('%s → %s', (key, expected) => {
    expect(cell(mode('daemon', IDENTITIES[key] as DaemonIdentity, false))).toBe(expected);
  });

  it('only launches for the commands allowed to, and only when nothing is there', () => {
    expect(cell(mode('daemon', IDENTITIES.absent as DaemonIdentity, false, NO_PID, true))).toBe(
      'launch',
    );
    expect(cell(mode('daemon', IDENTITIES.absent as DaemonIdentity, false, NO_PID, false))).toBe(
      'error:DAEMON_UNAVAILABLE',
    );
    // Never from a state that could not be identified — spawning against an
    // occupied port is a guaranteed race (M4-2).
    expect(
      cell(mode('daemon', IDENTITIES.unverifiable as DaemonIdentity, false, NO_PID, true)),
    ).toBe('error:DAEMON_UNVERIFIED');
  });

  it('rejects --direct as a usage error, in every state', () => {
    for (const identity of Object.values(IDENTITIES)) {
      expect(cell(mode('daemon', identity, true))).toBe('error:USAGE_ERROR');
    }
  });
});

describe('local commands', () => {
  it('reject --direct rather than silently ignoring it', () => {
    expect(cell(mode('none', IDENTITIES.absent as DaemonIdentity, true))).toBe('error:USAGE_ERROR');
  });
});

describe('completeness', () => {
  it('answers every state × need × flag combination', () => {
    // The guard against a `switch` that grew a hole: every cell must produce a
    // decision, and none may be `undefined`.
    for (const need of ['read', 'write', 'daemon', 'none'] as const) {
      for (const identity of Object.values(IDENTITIES)) {
        for (const direct of [true, false]) {
          for (const localPid of [NO_PID, LIVE_PID]) {
            const decision = decideMode({ need, direct, identity, localPid });
            expect(decision, `${need}/${identity.state}/${direct}`).toBeDefined();
            expect(typeof decision.kind).toBe('string');
          }
        }
      }
    }
  });
});
