// The daemon PID lock (M2-3) — the WRITE half.
//
// Reading the pid file lives in `@lark/core/daemon-control` since M6: the user
// CLI has to inspect it too, and it may not depend on this package. What stays
// here is what only a daemon does — take the lock, and release it if it is
// still ours.
//
// `removePid` deletes the file only when it still contains OUR pid, so a late
// teardown cannot remove the next daemon's lock.

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { paths, readPid } from '@lark/core';

/** A live daemon already holds the lock. */
export class DaemonAlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(`daemon is already running (PID: ${pid})`);
    this.name = 'DaemonAlreadyRunningError';
  }
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
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
      const existing = readPid(p); // live → pid; stale → unlinked + null
      if (existing !== null) throw new DaemonAlreadyRunningError(existing);
      // stale file removed → retry the exclusive create
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  throw new DaemonAlreadyRunningError(readPid(p) ?? process.pid);
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
