// Step ⑧: this library is not this install's. Make it so (§2.2.2).
//
// NOT `unbindLibrary`. That one is written for a user who chose to leave a
// workspace: it refuses when there are unpushed changes, it moves the
// credential file aside so a failure can put it back, and it wants a complete
// `CredentialStore` (`unbind.ts`). Here there is no user in the room and
// nothing worth keeping — the changes in the outbox were made by an install
// that is not this one, and publishing them under this identity is the exact
// thing converge exists to prevent. So: an explicit list, and the two
// functions evolve apart on purpose.
//
// WHAT IT DOES NOT TOUCH: `sync_file_ops`. Those rows are the consequence of
// writes that ALREADY COMMITTED — the library tables say a song was deleted,
// and the journal is what still owes the file half. Clearing them would leave
// orphaned directories nobody can explain. They belong to the boot drain at
// step ⑪, which runs a few lines later.
//
// `device_uuid` goes, and step ⑨ mints a new one. It means "this install's
// local identity" (`sync/changes.ts`), and sync decides tombstones and echoes
// by it — two installs sharing one would be two installs answering for each
// other's deletions.

import { bumpBackfillTarget } from '@lark/core/portable';
import type { PortableDb } from '@lark/core/portable';
import type { CredentialStore } from '@lark/core/portable';
import { INSTALL_ID_KEY } from './snapshot';

export interface ConvergeResult {
  /**
   * The transaction had already committed on an earlier, crashed attempt —
   * nothing was done this time.
   */
  alreadyConverged: boolean;
  changes: number;
  tombstones: number;
  deadLetters: number;
  cursors: number;
  bindings: number;
  /** Left alone on purpose — reported so the panel can assert it stayed. */
  fileOpsKept: number;
}

export interface ConvergeOptions {
  db: PortableDb;
  /** The identity this install is claiming. */
  installId: string;
  /** Cleared after the database work commits. */
  credentials: CredentialStore;
}

/**
 * Claim the library, in one transaction, then drop the credentials.
 *
 * The credential clear is deliberately AFTER the commit and not compensated:
 * unlike unbind there is no state worth restoring on failure. A converge that
 * fails leaves the library unclaimed and the old credentials in place, and the
 * next launch — seeing a library it has no identity for — converges again.
 * That re-entry is the compensation.
 *
 * IDEMPOTENT, and it has to be. A crash between this transaction and the
 * SecureStore commit leaves an intent that the next launch redoes verbatim —
 * so this runs twice. Every clear here survives that; `bumpBackfillTarget`
 * does not, and a double bump costs the next login a whole extra backfill
 * pass. MEASURED: criterion 19④ caught exactly that, `backfill target 1 → 3`.
 *
 * The marker is `install_id` itself, read INSIDE the transaction that writes
 * it. Same transaction as every clear, so it is exact rather than a heuristic:
 * either all of this happened or none of it did.
 */
export function convergeLibrary(options: ConvergeOptions): ConvergeResult {
  const { db, installId } = options;
  const { sqlite } = db;

  const result = sqlite
    .transaction(() => {
      const current = (
        sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(INSTALL_ID_KEY) as
          | { value: string }
          | undefined
      )?.value;
      const fileOpsKept = (
        sqlite.prepare('SELECT count(*) AS n FROM sync_file_ops').get() as { n: number }
      ).n;

      if (current === installId) {
        return {
          alreadyConverged: true,
          changes: 0,
          tombstones: 0,
          deadLetters: 0,
          cursors: 0,
          bindings: 0,
          fileOpsKept,
        };
      }

      const changes = sqlite.prepare('DELETE FROM sync_changes').run().changes;
      const tombstones = sqlite.prepare('DELETE FROM sync_tombstones').run().changes;
      const deadLetters = sqlite.prepare('DELETE FROM sync_dead_letters').run().changes;
      const cursors = sqlite.prepare('DELETE FROM sync_cursor').run().changes;
      const bindings = sqlite.prepare('DELETE FROM sync_binding').run().changes;

      // Every identity the server issued to whoever had this library. GLOB and
      // not LIKE: `_` is a LIKE wildcard, and a pattern that also matched
      // `skybridgeXdevice_id` is not the promise this line makes.
      sqlite.prepare("DELETE FROM local_metadata WHERE key GLOB 'skybridge_*'").run();

      // Step ⑨ mints the replacement.
      sqlite.prepare("DELETE FROM local_metadata WHERE key = 'device_uuid'").run();

      sqlite
        .prepare('INSERT OR REPLACE INTO local_metadata (key, value) VALUES (?, ?)')
        .run(INSTALL_ID_KEY, installId);

      // Everything that survived has to be republished, because the outbox
      // that proved it was published is gone. Same reasoning as unbind's, and
      // leaving it out is the kind of omission that shows up at N5 as a
      // library that syncs but never sends what it already had.
      bumpBackfillTarget(sqlite);

      return {
        alreadyConverged: false,
        changes,
        tombstones,
        deadLetters,
        cursors,
        bindings,
        fileOpsKept,
      };
    })
    .immediate();

  // Safe to repeat: `delete()` on nothing answers false.
  options.credentials.delete();
  return result;
}

/**
 * The fresh path's identity write (step ⑦'s tail).
 *
 * Same row, no cleanup: a library this install just created has nothing that
 * belonged to anyone else.
 */
export function claimFreshLibrary(db: PortableDb, installId: string): void {
  db.sqlite
    .prepare('INSERT OR REPLACE INTO local_metadata (key, value) VALUES (?, ?)')
    .run(INSTALL_ID_KEY, installId);
}
