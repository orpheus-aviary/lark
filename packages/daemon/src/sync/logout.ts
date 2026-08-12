// Logging out (v0.2 T3b, §3.7 / §3.11).
//
// The order is the whole content of this file:
//
//   bump the epoch and stop the triggers   nothing new starts
//   abort the round in flight and drain    nothing old finishes into a dead
//                                          session
//   drop the session and the [auth] section
//   best-effort remote logout
//
// The remote call goes LAST because it is the only step allowed to fail. A
// server that is unreachable must not leave this device logged in locally —
// the user asked to log out, and the credential they wanted gone is on this
// disk, not on that server.
//
// What SURVIVES a logout is as deliberate as what does not: the device
// registration, the workspace, the binding and the cursor all stay, so logging
// back in continues where this left off instead of registering a second device
// and re-pulling the workspace from zero. Only `unbind` takes those.

import {
  type SkybridgeCredentials,
  readSkybridgeCredentials,
  writeSkybridgeCredentials,
} from '@lark/core';
import type { AppContext } from '../context.js';
import type { SkybridgeClient } from './client.js';

export interface SyncLogoutResult {
  /** False when there was nothing to log out of. */
  had_session: boolean;
  /** True when the server confirmed the token is gone. */
  revoked_remotely: boolean;
}

export function performSyncLogout(ctx: AppContext): Promise<SyncLogoutResult> {
  return ctx.sync.lifecycle(() => logout(ctx));
}

async function logout(ctx: AppContext): Promise<SyncLogoutResult> {
  const session = ctx.sync.session;
  const client: SkybridgeClient | null = session?.client ?? null;

  // Stops triggers, aborts the in-flight round and waits for it to unwind.
  await ctx.sync.teardownSession();
  ctx.sync.noteAuthRequired('missing_session');

  clearStoredAuth();

  let revokedRemotely = false;
  if (client !== null) {
    try {
      await client.logout();
      revokedRemotely = true;
    } catch (err) {
      // Already local-only at this point: the token is off the disk and out of
      // memory, and a server that never heard about it will expire it anyway.
      ctx.logger.warn({ err }, 'remote logout failed — the local session is gone regardless');
    }
  }

  ctx.logger.info(
    { had_session: session !== null, revoked_remotely: revokedRemotely },
    'sync logged out',
  );
  return { had_session: session !== null, revoked_remotely: revokedRemotely };
}

/**
 * Rewrite the credential file without its `[auth]` section.
 *
 * A whole-file rewrite rather than an edit, for the same reason every write to
 * this file is: the writer holds the complete truth, and merging would be how
 * a stale token outlives the logout that removed it.
 */
function clearStoredAuth(): void {
  let credentials: SkybridgeCredentials | null = null;
  try {
    credentials = readSkybridgeCredentials();
  } catch {
    // Unreadable: there is no session to describe, and rewriting a file we
    // could not parse would throw away device and workspace ids for nothing.
    return;
  }
  if (credentials === null || credentials.auth === undefined) return;

  const { auth: _gone, ...rest } = credentials;
  writeSkybridgeCredentials(rest);
}
