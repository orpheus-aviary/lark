// The open policy for a host that does not migrate (N2b, §2.4).
//
// The desktop's dispatch lives in `db/index.ts` and has six outcomes because
// it serves real libraries with real history: it forward-migrates v1 and v2,
// and it recognises the Go-era schema. The Android client has neither the
// safety net that makes migrating defensible (writer lock, backup-and-swap,
// the mp3 scan) nor a way to have produced such a library in the first place —
// anything but a fresh or a current library can only have arrived by restore
// or file copy. So it accepts exactly TWO shapes and refuses the rest:
//
//   user_version > 3            -> IncompatibleDbError
//   0, schema empty             -> 'fresh'   (migrate 0->3, clear the flag)
//   0, Go legacy fingerprint    -> GoMigrationRequiredError
//   0, anything else non-empty  -> IncompatibleDbError
//   1 or 2                      -> ForwardMigrationUnsupportedError (decision m)
//   3                           -> 'current' (assert the signature, open)
//
// It lives in portable, not in `apps/mobile`, for the reason the subplan's §3
// gives: N2b has to produce something UNIT-TESTABLE. Nothing here names a
// host, so the six cells a phone will hit are six cells a desktop test runner
// executes — against better-sqlite3, through the same `SqliteLike` the
// expo-sqlite shim satisfies.
//
// SPLIT IN TWO ON PURPOSE. The frozen boot sequence (§2.2) classifies at step
// ③ on a COPY, with zero writes, before it has touched SecureStore or the real
// file; only at step ⑦, with the real handle open for writing, may anything be
// migrated. A single `open()` could not be used at step ③ at all.

import {
  ForwardMigrationUnsupportedError,
  GoMigrationRequiredError,
  IncompatibleDbError,
} from './errors.js';
import {
  LATEST_KNOWN_VERSION,
  applyForwardMigrations,
  isGoLegacyDb,
  isSchemaEmpty,
} from './migrate.js';
import { clearAudioMigrationPending } from './pending.js';
import { assertCurrentSchema } from './schema-signature.js';
import type { SqliteLike } from './sqlite.js';

/** The only two library shapes this host will open. */
export type LibraryVerdict = 'fresh' | 'current';

/**
 * Read the library's shape, or throw. **Writes nothing.**
 *
 * Safe to run against the zero-write copy D16 takes (§2.2 step ③) — and that
 * is the point of it being separate. Every refusal happens here, before the
 * caller has set `journal_mode` on anything: WAL is a FILE-level property, so
 * setting it before the verdict would modify a database this host had just
 * decided it must not touch.
 *
 * `dbPath` is only ever put in error messages; nothing here opens a file.
 */
export function classifyLibrary(sqlite: SqliteLike, dbPath: string): LibraryVerdict {
  const version = sqlite.pragma('user_version', { simple: true }) as number;

  // Before the v===0 handling, or a future database reads as brand new.
  if (version > LATEST_KNOWN_VERSION) {
    throw new IncompatibleDbError(dbPath, version, LATEST_KNOWN_VERSION);
  }

  if (version === 0) {
    if (isSchemaEmpty(sqlite)) return 'fresh';
    // The Go importer is gone (0.3 removed it) and was a desktop dev command
    // besides, so this branch cannot lead anywhere here. Recognising the shape
    // is still worth its four lines: the alternative is telling someone their
    // library has an "unrecognized schema", which is the same refusal with
    // none of the explanation.
    if (isGoLegacyDb(sqlite)) throw new GoMigrationRequiredError(dbPath);
    throw new IncompatibleDbError(dbPath, 0, LATEST_KNOWN_VERSION);
  }

  if (version < LATEST_KNOWN_VERSION) {
    throw new ForwardMigrationUnsupportedError(dbPath, version);
  }

  // v === LATEST. Don't trust the number alone — one definition of "current".
  assertCurrentSchema(sqlite, dbPath);
  return 'current';
}

export interface PrepareLibraryOptions {
  /**
   * Called once the verdict is in and before anything is written.
   *
   * This is where a host sets `journal_mode = WAL`, and the reason it is a
   * callback rather than something each host does around this call: WAL is a
   * FILE-level property, so setting it a moment too early modifies a database
   * that is about to be refused. Handing the host a hook means the ordering
   * lives here, tested once, instead of being a rule every host is trusted to
   * re-derive. Never called on a refusal.
   */
  onVerdict?: (verdict: LibraryVerdict) => void;
}

/**
 * Bring the library to the current schema on a handle open for writing
 * (§2.2 step ⑦), and say which shape it turned out to be.
 *
 * It classifies AGAIN rather than taking step ③'s verdict as a parameter. The
 * verdict was read from a copy; re-deriving it costs two pragma reads and
 * means no code path can act on a stale answer about a file it is about to
 * write to.
 *
 * NOT a usable library yet. §2.2 continues: converge (⑧), `ensureDeviceUuid`
 * (⑨), commit the intent (⑩), drain the file-op journal (⑪). Skipping ⑨ in
 * particular leaves a library that reads perfectly and throws on the first
 * write — see `db-identity.ts`.
 */
export function prepareLibrary(
  sqlite: SqliteLike,
  dbPath: string,
  options: PrepareLibraryOptions = {},
): LibraryVerdict {
  const verdict = classifyLibrary(sqlite, dbPath);
  options.onVerdict?.(verdict);

  if (verdict === 'fresh') {
    applyForwardMigrations(sqlite, 0, LATEST_KNOWN_VERSION);
    // 0003 marks every library reaching v3 as owing the mp3 -> m4a conversion,
    // because it cannot know what `songs/` holds. This one was created from
    // nothing by the line above, so it owes nothing.
    //
    // A crash between 0003's commit and this line leaves the flag set on an
    // empty library, which costs one scan of an empty directory. The reverse
    // ordering would risk a v3 library whose files nobody ever converts, so
    // the window is deliberately on this side — same choice the desktop makes.
    clearAudioMigrationPending(sqlite);
  }

  // 'current' needs nothing: `classifyLibrary` already asserted the signature,
  // and the pending flag is NOT this host's business to clear — only a library
  // this call created from nothing is known to owe nothing.
  return verdict;
}
