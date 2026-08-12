// Which workspace this library belongs to (v0.2 T3a, §3.7).
//
// One row, written at the first successful login and never updated. It is the
// answer to a question nothing else can answer: entity ids are local UUIDs, so
// two different workspaces would happily accept the same library and each
// would end up holding half of its history under ids the other also uses.
// Nothing downstream can separate them again — not the LWW key, not the
// tombstones, not a dead-letter archive.
//
// Hence the shape: a singleton (`CHECK (id = 1)` in 0002), an insert that
// refuses to overwrite, and a check every later login runs against all three
// identity fields before anything else in the install sequence happens. The
// only way out is `lark sync unbind`, which is deliberate, refuses to run with
// unpushed work, and says so.

import type BetterSqlite3 from 'better-sqlite3';
import { SyncBindingMismatchError } from '../errors.js';

export interface SyncBinding {
  server_id: string;
  user_id: string;
  workspace_id: string;
  /** The workspace's `schema_version` at bind time (§3.7 schema gate). */
  schema_version: number;
  bound_at: number;
}

/** What a login is proposing to bind to. */
export type SyncBindingCandidate = Omit<SyncBinding, 'bound_at'>;

export function readBinding(sqlite: BetterSqlite3.Database): SyncBinding | null {
  const row = sqlite
    .prepare(
      'SELECT server_id, user_id, workspace_id, schema_version, bound_at FROM sync_binding WHERE id = 1',
    )
    .get() as SyncBinding | undefined;
  return row ?? null;
}

/**
 * Refuse a candidate that does not match the existing binding.
 *
 * Reports the FIRST field that differs rather than a generic "mismatch": the
 * three cases mean genuinely different things to the person reading it — a
 * different server is a typo'd URL, a different user is the wrong account, a
 * different workspace is a server-side re-creation.
 */
export function assertBindingMatches(binding: SyncBinding, candidate: SyncBindingCandidate): void {
  const fields = ['server_id', 'user_id', 'workspace_id'] as const;
  for (const field of fields) {
    if (binding[field] !== candidate[field]) {
      throw new SyncBindingMismatchError(field, binding[field], candidate[field]);
    }
  }
}

/**
 * Write the binding. Assumes the caller's transaction — it commits together
 * with the backfill, the rebase and the device-id restamp, so a library can
 * never come up bound but unpublished (§3.7).
 *
 * Throws if a binding already exists: the caller checks first with
 * `assertBindingMatches`, and reaching here with a row present means two
 * logins raced, which is exactly the case that must not be resolved by
 * overwriting.
 */
export function writeBindingInTx(
  sqlite: BetterSqlite3.Database,
  candidate: SyncBindingCandidate,
  nowMs: number = Date.now(),
): SyncBinding {
  const existing = readBinding(sqlite);
  if (existing !== null) {
    assertBindingMatches(existing, candidate);
    return existing;
  }
  sqlite
    .prepare(
      `INSERT INTO sync_binding (id, server_id, user_id, workspace_id, schema_version, bound_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
    )
    .run(
      candidate.server_id,
      candidate.user_id,
      candidate.workspace_id,
      candidate.schema_version,
      nowMs,
    );
  return { ...candidate, bound_at: nowMs };
}

/** Forget the binding. Only `unbind` does this, inside its own transaction. */
export function clearBindingInTx(sqlite: BetterSqlite3.Database): void {
  sqlite.prepare('DELETE FROM sync_binding').run();
}
