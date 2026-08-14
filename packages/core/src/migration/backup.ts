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
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { larkDir, migrationBackupDir } from '../paths.js';

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
