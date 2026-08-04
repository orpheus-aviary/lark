// The daemon PID lock (M2-3). Three deliberate departures from owl, each
// because owl's version fails open:
//
//   1. Content validation. owl rejects only NaN, so an empty file parses as 0
//      and a negative number parses fine — and `kill(0, sig)` / `kill(-n, sig)`
//      address the PROCESS GROUP. Here the content must be `^\d+$`, a safe
//      integer, and > 1; anything else is corruption, and corruption is
//      fail-closed (a half-written file is most likely a concurrent boot
//      between its `wx` create and its write — exactly when NOT to steal the
//      lock).
//   2. Liveness. owl treats ANY `kill(pid, 0)` throw as "stale" and unlinks.
//      EPERM means the pid is alive and owned by someone else — deleting the
//      file there hands the lock away while a process still holds it. Only
//      ESRCH counts as stale.
//   3. Ownership on release. `removePid` deletes the file only when it still
//      contains OUR pid, so a late teardown can't remove the next daemon's lock.

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { paths } from '@lark/core';

/** A live daemon already holds the lock. */
export class DaemonAlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(`daemon is already running (PID: ${pid})`);
    this.name = 'DaemonAlreadyRunningError';
  }
}

/** The pid file exists but holds something that is not a plausible pid. */
export class PidFileCorruptError extends Error {
  constructor(
    readonly path: string,
    readonly raw: string,
  ) {
    super(
      `pid file ${path} contains ${JSON.stringify(raw)}, which is not a valid pid — refusing to start. Check for a running daemon, then delete the file by hand.`,
    );
    this.name = 'PidFileCorruptError';
  }
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * The pid of the live daemon, or `null` when nothing holds the lock.
 *
 * Side effect (inherited from owl, and the reason this is not a pure read): a
 * pid whose process is gone (ESRCH) leaves a stale file, which is removed here
 * so the caller's next exclusive create can win.
 *
 * @throws PidFileCorruptError when the file content is not a plausible pid.
 */
export function readPid(): number | null {
  const p = paths.pidPath();
  let raw: string;
  try {
    raw = readFileSync(p, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }

  const text = raw.trim();
  if (!/^\d+$/.test(text)) throw new PidFileCorruptError(p, text);
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new PidFileCorruptError(p, text);

  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') return pid; // EPERM etc: alive
    try {
      unlinkSync(p);
    } catch (unlinkErr) {
      if (!isEnoent(unlinkErr)) throw unlinkErr;
    }
    return null;
  }
}

/**
 * Take the lock atomically. `openSync(p, 'wx')` is the whole mechanism — not
 * check-then-write, which lets two concurrent boots both pass the check and
 * the loser's release delete the winner's file. On EEXIST we consult
 * `readPid()`: a live owner throws, a stale one is cleaned up there, so a
 * single retry of the exclusive create is enough.
 */
export function acquireDaemonLock(): void {
  const p = paths.pidPath();
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(p, 'wx'); // O_CREAT | O_EXCL
      writeSync(fd, String(process.pid));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = readPid(); // live → pid; stale → unlinked + null
      if (existing !== null) throw new DaemonAlreadyRunningError(existing);
      // stale file removed → retry the exclusive create
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  throw new DaemonAlreadyRunningError(readPid() ?? process.pid);
}

/** Release the lock, but only if it is still ours. */
export function removePid(): void {
  const p = paths.pidPath();
  let raw: string;
  try {
    raw = readFileSync(p, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  if (raw.trim() !== String(process.pid)) return; // someone else owns it now
  try {
    unlinkSync(p);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}
