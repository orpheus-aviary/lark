// The one time this device's library moves (N7c, §2.3).
//
// A desktop that has been syncing since 0.2 has a library at the nest root
// that is ALREADY BOUND to an account. N7 says an account's library lives at
// `libraries/<id>/`, so exactly one library on exactly one device has to walk
// there — once, on the first launch of the version that knows about
// workspaces. A library with no binding does not move: it IS the local
// workspace, in place, which is the whole zero-migration story (§2.4).
//
// 🔴 THE PHONE DOES NOT DO THIS. The user's decision, and a good one: a phone
// can be reinstalled and re-pulled in five minutes (N6's device session
// measured it), so the code that could lose a library is written once, and
// only where the library is irreplaceable.
//
// WHY IT IS RESUMABLE RATHER THAN ATOMIC. Several entries move — the database,
// its sidecars, `songs/`, the credentials, the two quarantine directories —
// and no filesystem moves several things at once. Each individual `rename` IS
// atomic, so at any instant every entry is at its source or at its target and
// never in between; what the journal adds is knowing which of the two the SET
// is supposed to be in. Written before the first move, removed after the last.
//
// THE ORDER, and what a power cut just after each step costs:
//
//   ① decide             nothing written; the next launch decides again
//   ② take both locks    nothing written; the locks die with the process
//   ③ write the journal  the next launch RESUMES; the library is still whole
//   ④ move each entry    the next launch resumes and finishes the rest
//   ⑤ write the index    the next launch resumes and rewrites it (idempotent)
//   ⑥ drop the journal   done
//
// So a kill at any point converges to "moved" or "not started" — never to a
// library half in each place (criterion 108).
//
// TWO LOCKS AND NOT ONE, because they exclude different people: the SWITCH
// lock is what `lark --direct` reads (it has no other way to learn that a
// library is on the move), and the WRITER lock is what `backup-nest` and any
// second writer take. Neither subsumes the other.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { WORKSPACES_FILE_NAME, writeWorkspaceIndex } from './config/workspaces.js';
import { acquireWriterLock } from './db/writer-lock.js';
import {
  DB_SIDECARS,
  WORKSPACE_ENTRIES,
  invalidateActiveWorkspace,
  larkDir,
  workspacePaths,
  workspacesPath,
} from './paths.js';
import type { StructuredLogger } from './portable/logger.js';
import {
  DEFAULT_WORKSPACE_INDEX,
  withActiveWorkspace,
  withWorkspaceEntry,
} from './portable/workspace-index.js';
import { WORKSPACE_LOCAL, computeWorkspaceId } from './portable/workspace.js';
import { newSwitchLockNonce, releaseSwitchLock, writeSwitchLock } from './switch-lock.js';

/** Present exactly while a move is unfinished. */
const JOURNAL_NAME = '.workspace-migration.json';

/** How long to wait for another writer before giving up and letting boot fail. */
const WRITER_WAIT_MS = 5_000;

export interface NestMigrationResult {
  /** Whether the library moved, on this run or an interrupted earlier one. */
  migrated: boolean;
  /** The workspace it now lives in, when it moved. */
  id: string | null;
  /** True when this run picked up an interrupted one. */
  resumed: boolean;
  /** The entries THIS run moved. Empty on a resume with nothing left to do. */
  moved: readonly string[];
  /** Why nothing happened, when nothing happened. */
  reason: string | null;
}

/**
 * The points criterion 108 kills at.
 *
 * A seam and not a mock: what has to be true is that THIS function, resumed
 * from where it actually stopped, converges. Reconstructing "half moved" by
 * hand in a test would only prove that the reconstruction converges.
 */
export type MigrationCrashPoint =
  | 'after-journal'
  | 'after-first-move'
  | 'after-moves'
  | 'after-index';

export interface NestMigrationOptions {
  logger?: StructuredLogger;
  /** Tests only. Throwing from here is the kill. */
  crashAt?: (point: MigrationCrashPoint) => void;
}

const nothing = (reason: string): NestMigrationResult => ({
  migrated: false,
  id: null,
  resumed: false,
  moved: [],
  reason,
});

function journalPath(): string {
  return join(larkDir(), JOURNAL_NAME);
}

/** The id an interrupted run was moving into, or null. Never throws. */
function readJournal(): string | null {
  const path = journalPath();
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const id = (parsed as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * The account this library is bound to, or null.
 *
 * A raw read-only connection, like owl's `local-inspect`: going through
 * `createDatabase` would run forward migrations, and this decision happens
 * before anything is entitled to write a byte.
 */
function boundWorkspaceId(dbFile: string): string | null {
  const sqlite = new BetterSqlite3(dbFile, { readonly: true, fileMustExist: true });
  try {
    const row = sqlite.prepare('SELECT server_id, user_id FROM sync_binding WHERE id = 1').get() as
      | { server_id: string; user_id: string }
      | undefined;
    if (row === undefined) return null;
    return computeWorkspaceId(row.server_id, row.user_id);
  } catch {
    // No such table: a Go-era library, or one from before v0.2. Not bound.
    return null;
  } finally {
    sqlite.close();
  }
}

/**
 * `[server].url` from the credentials, for the switcher's label. Never throws.
 *
 * A regex and not the TOML parser on purpose: this runs before anything has
 * validated that file, and a label is not worth a failed boot.
 */
function boundServerUrl(credentialsPath: string): string {
  try {
    return /^\s*url\s*=\s*"([^"]*)"/m.exec(readFileSync(credentialsPath, 'utf-8'))?.[1] ?? '';
  } catch {
    return '';
  }
}

/**
 * Fold the write-ahead log back into the database and leave no sidecars.
 *
 * 🔴 THE STEP THAT MAKES THE MOVE CONVERGE. `songs.db-wal` cannot travel with
 * `songs.db` atomically, and any read-only connection to a WAL database
 * creates a fresh pair without removing them (M6 measured it in the backup).
 * So if the sidecars were moved like everything else, a crash mid-move plus a
 * single reader anywhere would leave one at both ends — and a mover that
 * refuses to overwrite could never finish. After a checkpoint and a clean
 * close there is simply nothing to move.
 *
 * Safe to run on a resume too: the database is at one end or the other, and
 * this settles whichever one it is.
 */
function settleDatabase(dbFile: string, logger?: StructuredLogger): void {
  if (!existsSync(dbFile)) return;
  const sqlite = new BetterSqlite3(dbFile);
  try {
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    sqlite.close();
  }
  // SQLite removes them on the last close. If one survives, it belongs to a
  // database that has just been checkpointed, so it holds nothing that is not
  // already in the main file.
  for (const sidecar of DB_SIDECARS) {
    const path = join(dirname(dbFile), sidecar);
    if (!existsSync(path)) continue;
    logger?.warn({ path }, 'a WAL sidecar survived a clean close — removing it before the move');
    unlinkSync(path);
  }
}

/** Move one entry, or report that it has already moved. Never loses either. */
function moveEntry(from: string, to: string): boolean {
  if (!existsSync(from)) return false;
  if (existsSync(to)) {
    // Not reachable from this module's own steps — a rename leaves the entry
    // at exactly one of the two places — so it means something outside put a
    // library there. Refusing is the only safe answer: merging two libraries
    // is not something anybody can undo.
    throw new Error(`refusing to move ${from}: ${to} already exists`);
  }
  renameSync(from, to);
  return true;
}

/**
 * Put an already-bound nest library under `libraries/<id>/`, once.
 *
 * Called by daemon boot before it opens anything. Returns rather than throws
 * for every "nothing to do" case; a genuine failure mid-move throws, and the
 * next launch resumes from the journal.
 */
export function migrateBoundNestIntoWorkspace(
  options: NestMigrationOptions = {},
): NestMigrationResult {
  const { logger, crashAt } = options;
  const root = larkDir();
  const local = workspacePaths(WORKSPACE_LOCAL);
  const resuming = readJournal();

  let id: string;
  if (resuming !== null) {
    id = resuming;
    logger?.warn({ id }, 'resuming an interrupted workspace migration');
  } else {
    // ① Decide. An index means this device has already been through here —
    // including the ordinary case, where it had nothing to move.
    if (existsSync(join(root, WORKSPACES_FILE_NAME))) return nothing('already has an index');
    if (!existsSync(local.db)) return nothing('no library at the nest root');

    const bound = boundWorkspaceId(local.db);
    if (bound === null) return nothing('the library at the nest root is not bound to an account');
    id = bound;

    if (existsSync(workspacePaths(id).root)) {
      // Loud, and it moves nothing: two libraries claiming one account is a
      // state a person has to look at.
      logger?.error(
        { id },
        'the nest library is bound to an account that already has a workspace — leaving both alone',
      );
      return nothing('that account already has a workspace');
    }
  }

  const target = workspacePaths(id);
  const serverUrl = resuming === null ? boundServerUrl(local.skybridgeConfig) : '';

  // ② Both locks. The writer lock names the OLD path, which is where the
  // library still is and where every other writer is looking for it.
  const nonce = newSwitchLockNonce();
  writeSwitchLock(nonce);
  const writerLock = acquireWriterLock({ dbPath: local.db, busyTimeoutMs: WRITER_WAIT_MS });

  try {
    // ③ The journal, before the first move.
    mkdirSync(target.root, { recursive: true });
    const journal = journalPath();
    const tmp = join(dirname(journal), `${JOURNAL_NAME}.tmp-${process.pid}`);
    writeFileSync(tmp, JSON.stringify({ id, entries: WORKSPACE_ENTRIES }), 'utf-8');
    renameSync(tmp, journal);
    crashAt?.('after-journal');

    // ③b Settle the database wherever it currently is, so the move is one
    // rename of one file rather than three that have to agree.
    settleDatabase(existsSync(local.db) ? local.db : target.db, logger);

    // ④ Move.
    const moved: string[] = [];
    for (const entry of WORKSPACE_ENTRIES) {
      if (moveEntry(join(root, entry), join(target.root, entry))) {
        moved.push(entry);
        if (moved.length === 1) crashAt?.('after-first-move');
      }
    }
    crashAt?.('after-moves');

    // ⑤ The index, whole and atomic: the moment it lands, this device opens
    // the new workspace.
    writeWorkspaceIndex(
      withWorkspaceEntry(withActiveWorkspace(DEFAULT_WORKSPACE_INDEX, id), id, {
        label: '',
        server_url: serverUrl,
      }),
      workspacesPath(),
    );

    crashAt?.('after-index');

    // ⑥ Done. Only now is there nothing left to resume.
    unlinkSync(journal);

    invalidateActiveWorkspace();
    logger?.info(
      { id, moved, resumed: resuming !== null },
      'the nest library moved into its workspace',
    );
    return { migrated: true, id, resumed: resuming !== null, moved, reason: null };
  } finally {
    writerLock.release();
    releaseSwitchLock(nonce);
  }
}
