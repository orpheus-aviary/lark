// `GET /sync/status` (v0.2 T3c, §4.4).
//
// Everything here is read fresh, and most of it is read from DISK rather than
// from memory. That is the point: a file operation that failed, a song
// quarantined by a peer's delete, an inbound change nobody could parse — all
// of those outlive the process that met them, and a status built from
// in-memory counters would forget them at the next restart. The user's only
// other clue would be a song that quietly never plays.
//
// The three "is it usable" fields are deliberately separate:
//
//   configured     there is a server URL on disk
//   authenticated  there is a session in memory right now
//   bound          this library belongs to a workspace
//
// A logged-out install that is still bound is a normal, recoverable state; a
// bound library pointed at a DIFFERENT workspace is a refusal. One boolean
// could not tell those apart.

import {
  countDeadLetters,
  countDuplicateSourceKeySongs,
  countFileOps,
  countPendingChanges,
  countQuarantined,
  readBinding,
  readCursor,
  readSkybridgeCredentials,
} from '@lark/core';
import type { SyncStatusData } from '@lark/shared';
import type { AppContext } from '../context.js';

export function buildSyncStatus(ctx: AppContext): SyncStatusData {
  const session = ctx.sync.session;
  const binding = readBinding(ctx.sqlite);
  const credentials = readCredentialsQuietly(ctx);

  const cursor =
    binding === null
      ? { pulledSeq: 0, pushedSeq: 0 }
      : readCursor(ctx.sqlite, binding.server_id, binding.workspace_id);
  const deadLetters = countDeadLetters(ctx.sqlite);
  const fileOps = countFileOps(ctx.sqlite);

  return {
    configured: credentials !== null,
    authenticated: session !== null,
    bound: binding !== null,
    server_url: session?.serverUrl ?? credentials?.server.url ?? null,
    device_id: session?.deviceId ?? credentials?.device?.id ?? null,
    workspace_id: binding?.workspace_id ?? credentials?.workspace?.id ?? null,
    pending_count: countPendingChanges(ctx.sqlite),
    pulled_seq: cursor.pulledSeq,
    pushed_seq: cursor.pushedSeq,
    last_sync_at: ctx.sync.lastSyncAt,
    state: ctx.sync.state,
    // The union in the wire contract says this is non-null exactly when the
    // state is `auth_required`; keeping the two in step here is cheaper than
    // asking every reader to tolerate a stale reason.
    auth_reason: ctx.sync.state === 'auth_required' ? ctx.sync.authReason : null,
    last_error: ctx.sync.lastError,
    dead_letters: deadLetters,
    duplicate_source_keys: countDuplicateSourceKeySongs(ctx.sqlite),
    pending_file_ops: fileOps.pending,
    file_op_failures: fileOps.failed,
    quarantined_count: countQuarantined(),
    last_file_error: fileOps.lastError,
  };
}

/**
 * An unreadable credential file must not take the status endpoint down with
 * it — the status is where a user would find out about it.
 */
function readCredentialsQuietly(ctx: AppContext): ReturnType<typeof readSkybridgeCredentials> {
  try {
    return readSkybridgeCredentials();
  } catch (err) {
    ctx.logger.warn({ err }, 'sync credential file could not be read');
    return null;
  }
}
