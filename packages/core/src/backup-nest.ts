// Make a safe copy of the lark nest (M4-14⑦⑧).
//
// SQLite's online backup freezes the database and nothing else, so a copy that
// includes `songs/`, the lyrics and the config is only coherent if the writers
// are stopped. Hence the four contracts this implements:
//
//  1. Nobody may be running, and nobody may start. A reachable `/status` or a
//     live `daemon.pid` aborts the copy; the WRITER LOCK is held from before
//     the first file is copied until the database backup is done (M6-18 ④),
//     so a daemon or a `lark --direct` write that begins midway waits or
//     fails instead of changing `lark_config.toml` or a song file behind the
//     copy; and the source database is additionally held with
//     `locking_mode=EXCLUSIVE` for the duration.
//  2. The destination is ours. An explicit target must not exist and is
//     created here; the source directory, any ancestor of it, any descendant
//     of it and any symlink pointing back into it are refused. The default is
//     a fresh 0700 temp directory, because the copy contains
//     `lark_config.toml` and therefore the LLM api key.
//  3. Failure cleans up only what this run created.
//  4. Runtime state is never copied: the token, the pid file, the logs and the
//     migration lock belong to the process that made them — and since v0.2 the
//     skybridge credentials belong to the INSTALL that made them (§4.5).

import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { backupDatabase } from './db/backup.js';
import { acquireWriterLock } from './db/writer-lock.js';
import * as paths from './paths.js';

/** Never copied: state that belongs to a running process, not to the library. */
export const RUNTIME_ENTRIES = ['daemon-token', 'daemon.pid', 'logs'] as const;

/** Written by the backup itself, so the raw files are skipped by the copy. */
const DB_ENTRIES = ['songs.db', 'songs.db-wal', 'songs.db-shm'] as const;

/**
 * The two lock databases, WITH their sidecars.
 *
 * Prefix-matched rather than named exactly, because a held lock has a
 * `-journal` beside it: the backup now holds the writer lock for the whole
 * copy (M6-18 ④), so its journal is guaranteed to exist while `readdir` runs.
 * A lock file in a copy is meaningless at best — its fcntl state belongs to a
 * process on this machine — and misleading at worst.
 */
const LOCK_DB_NAMES = ['songs.db.migrate.lock', 'songs.db.writer.lock'] as const;

function isLockArtifact(name: string): boolean {
  return LOCK_DB_NAMES.some((lock) => name === lock || name.startsWith(`${lock}-`));
}

/**
 * Generated artefacts, excluded AT EVERY DEPTH (M6-14, sixth review ⑦).
 *
 * `lark skill export` writes its file with a same-directory temp + rename, and
 * `--output` may point anywhere inside the nest — including a subdirectory, in
 * which case a recursive copy would sweep up a half-written temp file that the
 * skip list above (top-level entry names only) never sees. Skipping by
 * BASENAME at every level is what makes that impossible; the artefact itself is
 * skipped too, since it can be regenerated at any time and is not library data.
 */
function isSkillArtifact(path: string): boolean {
  const name = basename(path);
  return name === paths.SKILL_FILE_NAME || name.startsWith(paths.SKILL_TEMP_PREFIX);
}

/**
 * The skybridge credentials, excluded at every depth (v0.2 §4.5).
 *
 * A backup is DISASTER RECOVERY, not a clone. Restoring one on a second
 * machine while the first still runs would give two installs the same device
 * identity and the same bearer token: both would push under one device id, and
 * the LWW key's third element — the tie-breaker that says WHO wrote something —
 * would stop distinguishing them. The supported way to make a second install is
 * to restore, then `lark sync unbind` and log in again, which mints a device of
 * its own.
 *
 * The temp prefix is here for the same reason as the skill one: `unbind` and
 * the login installer both move this file aside by rename, so a copy taken at
 * the wrong moment would otherwise pick up the stash instead of the file.
 */
function isSkybridgeArtifact(path: string): boolean {
  const name = basename(path);
  return name === paths.SKYBRIDGE_FILE_NAME || name.startsWith(paths.SKYBRIDGE_TEMP_PREFIX);
}

/**
 * A workspace index caught mid-rename (N7b).
 *
 * The file itself IS backed up — it holds an id and a label, not a token, and
 * a restored nest should come up pointing at the workspace it was pointing at.
 * Only the temp is skipped, for the reason the other two temps are: half a
 * file that decides which library opens is worse than no file, which reads as
 * `local`.
 */
function isWorkspaceIndexTemp(path: string): boolean {
  return basename(path).startsWith(paths.WORKSPACES_TEMP_PREFIX);
}

/** Everything generated or private that a copy must skip, at any depth. */
function isExcludedArtifact(path: string): boolean {
  return isSkillArtifact(path) || isSkybridgeArtifact(path) || isWorkspaceIndexTemp(path);
}

const STATUS_TIMEOUT_MS = 1000;

export interface BackupNestOptions {
  /** Destination NEST root; omitted means a fresh 0700 temp directory. */
  target?: string;
  /** Liveness seam. Defaults to `/status` plus the pid file. */
  probeRunning?: () => Promise<string | null>;
}

export interface BackupNestResult {
  /** The nest root of the copy (what `LARK_NEST_DIR` should point at). */
  nestDir: string;
  /** `<nest>/lark` inside the copy. */
  larkDir: string;
  /** Entries copied verbatim, excluding the database. */
  copied: readonly string[];
}

/** Non-null description of whoever is still running, or null when clear. */
export async function probeRunningDaemon(): Promise<string | null> {
  try {
    const res = await fetch('http://127.0.0.1:47100/status', {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (res.ok) return 'a daemon is answering on 127.0.0.1:47100';
  } catch {
    // Unreachable is the expected case.
  }
  try {
    const pid = Number((await readFile(paths.pidPath(), 'utf8')).trim());
    if (Number.isSafeInteger(pid) && pid > 0) {
      process.kill(pid, 0); // throws when the process is gone
      return `daemon.pid names a live process (${pid})`;
    }
  } catch {
    // No pid file, or the pid is stale — both mean nothing is running.
  }
  return null;
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

/**
 * Refuse a destination that overlaps the source in either direction. Both
 * sides are realpath'd first, so a symlink pointing back into the nest cannot
 * sneak past a string comparison.
 */
async function assertDisjoint(target: string, sourceNest: string): Promise<void> {
  const real = await realpath(target);
  if (isInside(real, sourceNest)) {
    throw new Error(`refusing to back up into the nest itself: ${real}`);
  }
  if (isInside(sourceNest, real)) {
    throw new Error(`refusing to back up into a parent of the nest: ${real}`);
  }
}

async function createTarget(target: string | undefined): Promise<string> {
  if (target === undefined) return await mkdtemp(join(tmpdir(), 'lark-nest-'));
  // Explicit targets must be new: this function removes what it creates on
  // failure, and that promise is only safe for directories it made.
  await mkdir(target, { recursive: false, mode: 0o700 });
  return target;
}

/**
 * Resolved paths, because the daemon reports `realpath(larkDir())` and the
 * GUI compares the two literally: on macOS `mkdtemp` hands back `/var/...`
 * while the daemon answers `/private/var/...`, and the reuse check would
 * refuse its own copy (measured in T6).
 */
async function resolved(nestDir: string): Promise<{ nestDir: string; larkDir: string }> {
  const real = await realpath(nestDir);
  return { nestDir: real, larkDir: join(real, 'lark') };
}

export async function backupNest(options: BackupNestOptions = {}): Promise<BackupNestResult> {
  const running = await (options.probeRunning ?? probeRunningDaemon)();
  if (running !== null) {
    throw new Error(
      `stop lark before copying the nest — ${running}. An online backup freezes the database only; songs/ and the config would come from a different moment.`,
    );
  }

  const sourceLark = await realpath(paths.larkDir());
  const sourceNest = await realpath(paths.nestDir());

  // Before the first byte is copied, and before the destination exists: the
  // liveness probe above is a snapshot, and only the lock keeps it true.
  const writerLock = acquireWriterLock({ dbPath: join(sourceLark, 'songs.db') });
  try {
    return await copyUnderLock(sourceLark, sourceNest, options.target);
  } finally {
    writerLock.release();
  }
}

/** The copy itself. Runs with the writer lock held; see {@link backupNest}. */
async function copyUnderLock(
  sourceLark: string,
  sourceNest: string,
  target: string | undefined,
): Promise<BackupNestResult> {
  const created = await createTarget(target);
  try {
    await assertDisjoint(created, sourceNest);
    const targetLark = join(created, 'lark');
    await mkdir(targetLark, { recursive: false, mode: 0o700 });

    const skip = new Set<string>([...RUNTIME_ENTRIES, ...DB_ENTRIES]);
    const copied: string[] = [];
    for (const entry of await readdir(sourceLark)) {
      if (skip.has(entry) || isLockArtifact(entry) || isExcludedArtifact(entry)) continue;
      await cp(join(sourceLark, entry), join(targetLark, entry), {
        recursive: true,
        preserveTimestamps: true,
        filter: (source) => !isExcludedArtifact(source),
      });
      copied.push(entry);
    }

    // Held for the whole copy, not just the backup call: a daemon that starts
    // midway must fail to open the library rather than write into it.
    const source = new BetterSqlite3(join(sourceLark, 'songs.db'), { fileMustExist: true });
    try {
      source.pragma('locking_mode = EXCLUSIVE');
      // A read does not take the lock (M1: even a RESERVED writer is invisible
      // to one). A same-value write does.
      const version = source.pragma('user_version', { simple: true }) as number;
      source.exec(`BEGIN IMMEDIATE; PRAGMA user_version = ${version}; COMMIT;`);
      await backupDatabase(source, join(targetLark, 'songs.db'));
    } finally {
      source.close();
    }

    return { ...(await resolved(created)), copied };
  } catch (err) {
    // Only ever the directory this run made — never a caller's existing tree.
    await rm(created, { recursive: true, force: true });
    throw err;
  }
}
