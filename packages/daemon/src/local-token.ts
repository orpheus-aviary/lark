/**
 * The daemon's local bearer token (R21/R29): generation + atomic publish.
 *
 * The token is generated in memory during context assembly — the auth gate has
 * it before the first request can arrive — but is PUBLISHED to disk only after
 * `listen()` succeeds, i.e. once this process owns the port. That ordering is
 * the whole point: a second daemon that loses the race never reaches
 * `publishLocalToken`, so it cannot clobber the running daemon's token file.
 *
 * The write is SYNCHRONOUS on purpose. It runs in the continuation of the
 * resolved `listen()` promise, and a request callback is a macrotask — it
 * cannot interleave into that microtask continuation. That is what makes
 * "`/status` answered ⇒ the token file is readable" true without a readiness
 * gate (M2-2). Do not make this async.
 *
 * Rotated on every boot. Shutdown deliberately leaves the file in place: it is
 * 0600 and worthless without a daemon listening, and deleting it would race a
 * successor boot that has already published its own.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { paths } from '@lark/core';

/** A fresh 256-bit token, base64url. No disk I/O. */
export function generateLocalToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Atomically publish `token` to the 0600 token file: O_EXCL temp created with
 * mode 0600 (never a default-permission window), then `rename` over the
 * destination. Any failure removes the temp and rethrows — the caller aborts
 * boot, because a daemon whose clients cannot authenticate is useless.
 */
export function publishLocalToken(token: string): void {
  const dest = paths.localTokenPath();
  const tmp = `${dest}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600); // mode applied at creation
    writeSync(fd, token);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, dest); // atomic replace; dest inherits the temp's 0600
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closing down — ignore
      }
    }
    try {
      unlinkSync(tmp); // never leave a stray temp behind
    } catch {
      // the temp may not exist (open failed) — ignore
    }
    throw err;
  }
}
