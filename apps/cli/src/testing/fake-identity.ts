// A scripted `IdentityResolver` for tests (T5).
//
// The real one talks to a socket and a pid file; every branch that matters to
// `ensureDaemon`, `lark daemon` and `lark stop-daemon` is a SEQUENCE of
// identity states ("absent, then current"), so tests script the sequence
// instead of staging two daemons.

import type { StatusData } from '@lark/shared';
import type { DaemonIdentity, IdentityResolver } from '../lib/identity.js';

export function statusData(pid: number, overrides: Partial<StatusData> = {}): StatusData {
  return {
    status: 'ok',
    pid,
    version: '0.1.0',
    uptime: 1,
    nest_fingerprint: 'a'.repeat(64),
    local_api_version: 3,
    ...overrides,
  };
}

export const identities = {
  absent: { state: 'absent' } as DaemonIdentity,
  current: (pid = 99): DaemonIdentity => ({ state: 'current', status: statusData(pid), pid }),
  otherNest: (pid: number | null = 7): DaemonIdentity => ({
    state: 'other-nest',
    pid,
    fingerprint: 'b'.repeat(64),
  }),
  incompatible: (pid: number | null = 7): DaemonIdentity => ({
    state: 'same-nest-incompatible',
    pid,
    remoteApiVersion: 2,
  }),
  /** A pid file that is alive but silent — what a daemon mid-boot looks like. */
  booting: (pid = 42): DaemonIdentity => ({
    state: 'occupied-unverifiable',
    reason: 'pid-file-live',
    pid,
  }),
  unverifiable: (): DaemonIdentity => ({
    state: 'occupied-unverifiable',
    reason: 'malformed-status',
    pid: null,
  }),
};

export interface FakeIdentity extends IdentityResolver {
  /** How many times anybody asked. */
  reads: number;
}

/**
 * Answer a scripted sequence: `resolve()` reports where the script is,
 * `resolveFresh()` advances it, and the last entry repeats — a poll loop has
 * to be able to see a stable final answer.
 */
export function fakeIdentity(states: readonly DaemonIdentity[]): FakeIdentity {
  let index = 0;
  const at = (): DaemonIdentity => states[Math.min(index, states.length - 1)] as DaemonIdentity;
  return {
    reads: 0,
    resolve() {
      this.reads += 1;
      return Promise.resolve(at());
    },
    resolveFresh() {
      this.reads += 1;
      index += 1;
      return Promise.resolve(at());
    },
  };
}
