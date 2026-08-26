// Does this library still carry a PRIOR account's sync state? (N7e)
//
// owl's `hasSyncTraces` (B8), and the same use: it drives the warning before a
// library is claimed into a NEW account. A library that has pushed under one
// workspace and is then republished under another sends everything the old one
// already had, under new keys, to a server that has never seen it.
//
// Only reachable on a library that was bound before N7 and kept in place as
// `local` — an account's own workspace carries these traces by definition and
// nobody is warned about that.
//
// PORTABLE because both hosts ask it: the desktop opens other workspaces
// read-only to inspect them, and the phone can only ask about the library it
// already has open (its host has no read-only open at all).

import type { SqliteLike } from '../sqlite.js';

/** A row exists for `sql`, treating a missing table (older schema) as "no". */
function hasRow(sqlite: SqliteLike, sql: string): boolean {
  try {
    return sqlite.prepare(sql).get() !== undefined;
  } catch {
    return false;
  }
}

export function hasSyncTraces(sqlite: SqliteLike): boolean {
  return (
    hasRow(sqlite, 'SELECT 1 FROM sync_cursor LIMIT 1') ||
    // Pushed, not merely queued: an outbox nobody has sent is what a library
    // that has never synced looks like.
    hasRow(sqlite, 'SELECT 1 FROM sync_changes WHERE synced_at IS NOT NULL LIMIT 1') ||
    hasRow(
      sqlite,
      "SELECT 1 FROM local_metadata WHERE key IN ('skybridge_device_id','skybridge_workspace_id') LIMIT 1",
    )
  );
}
