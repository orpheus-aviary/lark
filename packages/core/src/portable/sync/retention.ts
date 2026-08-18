import type { SqliteLike } from '../sqlite.js';
// Trimming the outbox (v0.2 T2, D5).
//
// `sync_changes` is an append-only log of everything this device ever did. On
// a library that syncs daily it outgrows the library itself, so rows the
// server has confirmed are dropped once they are old enough to be useless.
//
// What makes this safe in v0.2 and would NOT have been safe in v0.1: deletes
// survive the trim independently, in `sync_tombstones`. Before that, throwing
// away a `delete` row meant losing the only evidence that a missing entity was
// deleted rather than never seen — and a peer's older `create` would bring it
// back on the next pull.
//
// Two rules, both about not losing work:
//
//   Only rows with `synced_at` set. A pending change is unpublished work.
//   Only rows older than the horizon. A change accepted seconds ago may still
//   be needed to answer "is this echo mine" — self-replay reads exactly these
//   rows, and trimming one turns our own echo into someone else's change.

/** How long a settled change stays in the outbox. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RetentionResult {
  removed: number;
  /** The cut-off actually used, for the log line. */
  before: number;
}

/**
 * Drop settled changes older than the horizon.
 *
 * Dead letters and tombstones are untouched: the first is an archive somebody
 * will want to read, the second is load-bearing state.
 */
export function runRetention(
  sqlite: SqliteLike,
  options: { nowMs?: number; retentionMs?: number } = {},
): RetentionResult {
  const now = options.nowMs ?? Date.now();
  const before = now - (options.retentionMs ?? RETENTION_MS);
  const info = sqlite
    .prepare('DELETE FROM sync_changes WHERE synced_at IS NOT NULL AND synced_at < ?')
    .run(before);
  return { removed: info.changes, before };
}
