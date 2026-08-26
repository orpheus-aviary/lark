// The cross-process lock for "this device's layout is changing" (N7c).
//
// Two things move a whole library on this host: the one-time migration that
// puts an already-bound nest library under `libraries/<id>/` (§2.3), and a
// login that claims the local library into a new workspace by copying it
// (§2.6, N7e). Both spend seconds with a library half where it is going, and
// `lark --direct` is a separate process a person can start at any moment.
//
// THE SHAPE IS OWL'S (`../owl/packages/core/src/skybridge/switch-lock.ts`),
// and so are the three properties that make it safe:
//
//   ATOMIC WRITES (temp + rename). A reader never sees a torn file, not even
//     while the holder is refreshing the timestamp.
//   AN OWNER NONCE. `release` and `touch` act only on the lock THIS holder
//     wrote, so a stray process cannot delete somebody else's — including the
//     case that actually happens, a crashed run whose successor is now the
//     holder.
//   LIVENESS PLUS A TTL. A lock counts only if its pid is alive AND it was
//     refreshed inside the TTL. A crashed holder's pid disappears at once; a
//     pid REUSED after a crash is what the TTL is for, and it is the only
//     thing the TTL is for.
//
// 🔴 WHY BOTH HALVES ARE NEEDED, since either alone looks sufficient: pid
// liveness alone hands the lock to whatever process next gets that pid, and a
// TTL alone makes a slow-but-alive holder look dead. Together the answer is
// wrong only if a crashed holder's pid is reused AND the successor is asked
// about within 30 seconds — at which point the caller waits, which is the
// harmless direction.
//
// NO TIMERS HERE. The heartbeat belongs to whoever holds the lock, because
// only it knows whether it is still working. Pure functions are also what
// makes the liveness rule testable without a second process.

import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SWITCH_LOCK_TEMP_PREFIX, switchLockPath } from './paths.js';

/** A lock nobody has refreshed for this long is not being held. */
export const SWITCH_LOCK_TTL_MS = 30_000;

export interface SwitchLock {
  /** The holder, so a crash is visible immediately rather than in 30 seconds. */
  pid: number;
  /** Last refresh, in epoch ms. */
  started_at: number;
  /** The owner token. Only its holder may touch or release the lock. */
  nonce: string;
}

/** A fresh owner token. One per acquisition, never reused. */
export function newSwitchLockNonce(): string {
  return randomUUID();
}

function isSwitchLock(value: unknown): value is SwitchLock {
  if (typeof value !== 'object' || value === null) return false;
  const lock = value as Record<string, unknown>;
  return (
    typeof lock.pid === 'number' &&
    Number.isInteger(lock.pid) &&
    lock.pid > 0 &&
    typeof lock.started_at === 'number' &&
    Number.isInteger(lock.started_at) &&
    lock.started_at > 0 &&
    typeof lock.nonce === 'string' &&
    lock.nonce.length > 0
  );
}

function atomicWrite(path: string, lock: SwitchLock): void {
  const tmp = join(dirname(path), `${SWITCH_LOCK_TEMP_PREFIX}${process.pid}`);
  writeFileSync(tmp, JSON.stringify(lock), 'utf8');
  renameSync(tmp, path);
}

/** Take the lock under `nonce`. Whole-file, so a stale holder is replaced. */
export function writeSwitchLock(nonce: string, path: string = switchLockPath()): void {
  atomicWrite(path, { pid: process.pid, started_at: Date.now(), nonce });
}

/**
 * Heartbeat: push the timestamp forward, but only while we still own it.
 *
 * Silently does nothing when the lock is gone or somebody else's — a holder
 * that lost its lock has already lost the race, and stamping a stranger's file
 * with our clock would make the loss invisible.
 */
export function touchSwitchLock(nonce: string, path: string = switchLockPath()): void {
  const current = readSwitchLock(path);
  if (current === null || current.nonce !== nonce) return;
  atomicWrite(path, { pid: current.pid, started_at: Date.now(), nonce });
}

/** Release, if it is still ours. Never removes a lock we do not own. */
export function releaseSwitchLock(nonce: string, path: string = switchLockPath()): void {
  const current = readSwitchLock(path);
  if (current === null || current.nonce !== nonce) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone. Releasing twice is not an error.
  }
}

/** The lock on disk, or `null` for missing, torn or malformed. */
export function readSwitchLock(path: string = switchLockPath()): SwitchLock | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isSwitchLock(parsed) ? parsed : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to another user — alive, for our
    // purposes. ESRCH means it is gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True while somebody is actually moving this device's libraries around. */
export function isSwitchLockActive(lock: SwitchLock | null): boolean {
  if (lock === null) return false;
  if (!pidAlive(lock.pid)) return false;
  return Date.now() - lock.started_at < SWITCH_LOCK_TTL_MS;
}

/** True if a switch is in flight right now. The question every reader asks. */
export function switchInFlight(path?: string): boolean {
  return isSwitchLockActive(readSwitchLock(path));
}
