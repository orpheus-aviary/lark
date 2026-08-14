// `migration-backup/` — where an mp3 goes when it may not be deleted
// (0.3.0 T2, master plan §3.2-1 / §3.2-9).
//
// Two rules, and everything here exists to keep them:
//
//   A move NEVER overwrites. The target already existing means a previous run
//   got that far, and the only safe reading of "a different file is already
//   under this name" is that both are somebody's music. The second one goes to
//   a collision-safe name and gets reported, rather than one of them ceasing
//   to exist.
//
//   Paths recorded in the ledger are RELATIVE to the nest. A nest is copied
//   with `backup-nest` and reopened elsewhere through LARK_NEST_DIR, and an
//   absolute path baked into a row would be unresolvable there — the same rule
//   the sync file ops follow for their quarantine targets.

import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { larkDir, migrationBackupDir } from '../paths.js';
import { clearLedgerBackups } from './ledger.js';

/** Where an orphan's audio goes: not a song, so not under a song's name (§4-n). */
const ORPHANS_SUBDIR = 'orphans';

/** The backup file for an object, and the relative form the ledger stores. */
export function backupPathFor(
  objectKey: string,
  isOrphan: boolean,
): {
  absolute: string;
  relative: string;
} {
  const absolute = isOrphan
    ? join(migrationBackupDir(), ORPHANS_SUBDIR, `${objectKey}.mp3`)
    : join(migrationBackupDir(), `${objectKey}.mp3`);
  return { absolute, relative: relative(larkDir(), absolute) };
}

/**
 * Turn a ledger's relative `backup_path` into a path this process may touch.
 *
 * Null for anything that does not land inside `migration-backup/`. The rows are
 * written by this code, so a `../..` in one means the database was edited or
 * corrupted — and the caller is either a size report or a delete. Neither is
 * allowed to follow it out of the directory (§4-m, 判据 51).
 */
export function resolveBackupPath(relativePath: string): string | null {
  if (relativePath === '' || isAbsolute(relativePath)) return null;
  const root = migrationBackupDir();
  const absolute = resolve(larkDir(), relativePath);
  const inside = relative(root, absolute);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null;
  return absolute;
}

/** What `migration-backup/` is holding, and how much of it is irreplaceable. */
export interface BackupSummary {
  file_count: number;
  bytes: number;
  /** Backups of `kept_unconverted` objects: unconvertible AND not downloadable. */
  asset_count: number;
  asset_bytes: number;
}

export function summarizeMigrationBackups(sqlite: BetterSqlite3.Database): BackupSummary {
  const files = new Map<string, number>();
  for (const path of walkFiles(migrationBackupDir())) {
    files.set(path, statSync(path).size);
  }

  const summary: BackupSummary = {
    file_count: files.size,
    bytes: [...files.values()].reduce((sum, size) => sum + size, 0),
    asset_count: 0,
    asset_bytes: 0,
  };

  const kept = sqlite
    .prepare(
      `SELECT backup_path FROM audio_migration
        WHERE status = 'kept_unconverted' AND backup_path IS NOT NULL`,
    )
    .all() as { backup_path: string }[];
  for (const row of kept) {
    const absolute = resolveBackupPath(row.backup_path);
    const size = absolute === null ? undefined : files.get(absolute);
    if (size === undefined) continue; // escaped the directory, or already gone
    summary.asset_count++;
    summary.asset_bytes += size;
  }
  return summary;
}

/**
 * Delete everything under `migration-backup/`, then say what went.
 *
 * The ledger is updated FIRST, inside its own transaction. Both orders can be
 * interrupted, so the question is which lie survives a crash: rows that say
 * "no backup" while files remain (recoverable — clear again, and the report
 * still counts what is on disk), or rows that say "your original is safe in the
 * backup" after it has been deleted. Only one of those can cost someone a file
 * they were told they still had.
 */
export function clearMigrationBackups(
  sqlite: BetterSqlite3.Database,
  nowMs: number = Date.now(),
): { removed_count: number; freed_bytes: number } {
  const root = migrationBackupDir();
  const files = walkFiles(root);
  const freed = files.reduce((sum, path) => sum + statSync(path).size, 0);

  clearLedgerBackups(sqlite, nowMs);

  // The directory itself goes, and comes back on the next preflight. Removing
  // the tree rather than the paths the ledger names is also what makes this
  // confined by construction: nothing outside it is ever named.
  rmSync(root, { recursive: true, force: true });
  return { removed_count: files.length, freed_bytes: freed };
}

/** Every regular file under `dir`, following no symlink out of it. */
function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

export type MoveOutcome =
  /** The file is now at the target. */
  | { kind: 'moved'; target: string }
  /** The target already held a byte-identical copy; the source was removed. */
  | { kind: 'already-there'; target: string }
  /** The target held something else; the source went to `target` beside it. */
  | { kind: 'diverted'; target: string };

/**
 * Move `from` to `to`, never overwriting.
 *
 * A target holding an identical file is a rerun of a move that already
 * happened: the source is dropped and the move counts as done. A target
 * holding a DIFFERENT file is two songs claiming one name — the incoming one
 * is parked under `<name>.reconcile-N.mp3` and the caller records why.
 */
export function moveWithoutOverwrite(from: string, to: string): MoveOutcome {
  mkdirSync(join(to, '..'), { recursive: true });

  if (existsSync(to)) {
    if (sameFile(from, to)) {
      unlinkSync(from);
      return { kind: 'already-there', target: to };
    }
    const diverted = collisionSafeName(to);
    move(from, diverted);
    return { kind: 'diverted', target: diverted };
  }

  move(from, to);
  return { kind: 'moved', target: to };
}

/**
 * `<path>.reconcile-1.mp3`, `-2`, … — the first name nothing occupies.
 *
 * Bounded so a directory that somehow cannot be written to fails loudly
 * instead of spinning: 999 collisions on one object is not a state any real
 * library reaches.
 */
function collisionSafeName(path: string): string {
  const base = path.replace(/\.mp3$/, '');
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base}.reconcile-${n}.mp3`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`no free collision-safe name beside ${path}`);
}

function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    // `migration-backup/` and `songs/` are both inside the nest, so this is
    // not expected — but a rename that fails on EXDEV would otherwise be
    // reported as a permissions problem the user cannot fix.
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/** Same size and same SHA-256. Size first: it settles almost every case. */
function sameFile(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  return sha256(a) === sha256(b);
}

/**
 * Streamed in 1MiB chunks rather than `readFileSync`: this runs over a whole
 * music library, and a user with a long live recording in it should not need
 * that much memory to have their file compared.
 */
function sha256(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    let read = readSync(fd, buffer, 0, buffer.length, null);
    while (read > 0) {
      hash.update(buffer.subarray(0, read));
      read = readSync(fd, buffer, 0, buffer.length, null);
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}
