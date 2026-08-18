// Leaving a workspace (v0.2 T3a, §3.7 unbind).
//
// Unbind is the one deliberate way out of a binding, and it is destructive in
// a way that is easy to underestimate: it throws away the outbox and the
// tombstones. Everything that still EXISTS can be republished by the full
// backfill on the next login, but nothing that expresses itself by ABSENCE
// can — an unpushed song delete, a membership removal, a `clear_lyrics`.
// Re-binding the same workspace afterwards would meet the old `create` still
// sitting in the change log and resurrect exactly those.
//
// Hence the shape of this function:
//
//   the pending guard runs FIRST and refuses by default (R5-P1-3),
//   the journal is drained BEFORE anything is cleared — a queued file effect
//     describes a decision that is about to lose its record,
//   the credential file is moved aside rather than deleted, so a failure
//     anywhere in the database work can put it back.
//
// The caller owns the two things this cannot check for itself: the daemon must
// be stopped, and the writer lock must be held. `lark sync unbind` does both.

import { FileOpBusyError, SyncPendingChangesError } from '../errors.js';
import type { CredentialStash, CredentialStore } from '../ports/credentials.js';
import type { SqliteLike } from '../sqlite.js';
import { bumpBackfillTarget } from './backfill.js';
import { clearBindingInTx } from './binding.js';
import { type FileEffectLike, countFileOps } from './file-ops.js';

export interface UnpushedChanges {
  total: number;
  /**
   * The subset a backfill can never bring back: deletions and lyric clears.
   * Everything else still exists locally and gets a fresh `create` on the next
   * login.
   */
  unpublishedDeletes: number;
}

export function countUnpushedChanges(sqlite: SqliteLike): UnpushedChanges {
  const row = sqlite
    .prepare(
      `SELECT
         count(*) AS total,
         sum(CASE WHEN op IN ('delete','clear_lyrics') THEN 1 ELSE 0 END) AS deletes
       FROM sync_changes WHERE synced_at IS NULL`,
    )
    .get() as { total: number; deletes: number | null };
  return { total: row.total, unpublishedDeletes: row.deletes ?? 0 };
}

export interface UnbindOptions {
  sqlite: SqliteLike;
  /** Drained before anything is cleared. Omitted only when there is no journal to run. */
  fileOps?: FileEffectLike;
  /** Proceed even though unpushed changes will be lost. */
  force?: boolean;
  /**
   * Where this install's sync credentials live (N1c).
   *
   * A port rather than the credential FILE: unbind's compensation sequence is
   * "move aside, do the database work, then either restore or drop", and that
   * sequence is the same wherever the credentials are kept. Only the moving
   * aside is host-specific.
   */
  credentials: CredentialStore;
}

export interface UnbindResult {
  /** Rows removed, per table — what the command prints back. */
  changes: number;
  tombstones: number;
  deadLetters: number;
  cursors: number;
  /** What was given up because `--force` was passed. */
  discarded: UnpushedChanges;
  hadCredentials: boolean;
  /** The generation the next login will have to back-fill up to. */
  backfillTarget: number;
}

/**
 * Detach this library from its workspace.
 *
 * Not a transaction end to end — it cannot be, because a file drain and a file
 * rename are not database operations. What it guarantees instead is that each
 * step is either complete or undone: the journal is empty before the outbox is
 * cleared, the credential file is only deleted after the database work
 * committed, and a failure in that work puts the credentials back exactly
 * where they were.
 */
export async function unbindLibrary(options: UnbindOptions): Promise<UnbindResult> {
  const { sqlite } = options;

  const pending = countUnpushedChanges(sqlite);
  if (pending.total > 0 && options.force !== true) {
    throw new SyncPendingChangesError(pending.total, pending.unpublishedDeletes);
  }

  // ① The journal first. Its rows are decisions already committed to the
  // database whose file half has not happened yet; clearing the sync state
  // around them would leave effects nobody can explain later.
  if (options.fileOps !== undefined) await options.fileOps.drain();
  const journal = countFileOps(sqlite);
  const stuck = journal.pending + journal.failed;
  if (stuck > 0) {
    throw new FileOpBusyError(
      `${stuck} file operations are still queued (${journal.failed} of them permanently failed) — resolve them with \`lark sync file-ops\` before unbinding`,
    );
  }

  // ② Credentials aside, atomically, so ③ has something to fall back to.
  const stash: CredentialStash = options.credentials.stash();

  // ③ One transaction for all the database state.
  let result: UnbindResult;
  try {
    result = sqlite
      .transaction(() => {
        const changes = sqlite.prepare('DELETE FROM sync_changes').run().changes;
        const tombstones = sqlite.prepare('DELETE FROM sync_tombstones').run().changes;
        const deadLetters = sqlite.prepare('DELETE FROM sync_dead_letters').run().changes;
        const cursors = sqlite.prepare('DELETE FROM sync_cursor').run().changes;
        clearBindingInTx(sqlite);
        // Every identity the server issued. GLOB rather than LIKE: `_` is a
        // LIKE wildcard, and a pattern that also matches `skybridgeXdevice_id`
        // is not the promise this line is making.
        sqlite.prepare("DELETE FROM local_metadata WHERE key GLOB 'skybridge_*'").run();
        // Say it again for the next binding: everything that survives has to be
        // republished, because the outbox that proved it was published is gone.
        bumpBackfillTarget(sqlite);
        const target = Number(
          (
            sqlite
              .prepare(
                "SELECT value FROM local_metadata WHERE key = 'sync_backfill_target_generation'",
              )
              .get() as { value: string }
          ).value,
        );
        return {
          changes,
          tombstones,
          deadLetters,
          cursors,
          discarded: pending,
          hadCredentials: stash.existed,
          backfillTarget: target,
        } satisfies UnbindResult;
      })
      .immediate();
  } catch (err) {
    // ④ Failed: the library is still bound, so it must still have the
    // credentials that prove it.
    stash.restore();
    throw err;
  }

  // ④ Committed: drop the old credentials, and anything a previous attempt
  // left behind.
  stash.discard();
  options.credentials.delete();
  return result;
}
