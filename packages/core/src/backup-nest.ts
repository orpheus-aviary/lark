// Make a safe copy of the lark nest (M4-14⑦⑧).
//
// SQLite's online backup freezes the database and nothing else, so a copy that
// includes `songs/`, the lyrics and the config is only coherent if the writers
// are stopped. Hence the four contracts this implements:
//
//  1. Nobody may be running. A reachable `/status` or a live `daemon.pid`
//     aborts the copy, and the source database is held with
//     `locking_mode=EXCLUSIVE` for the duration — a daemon started midway
//     fails to open its library instead of silently making the copy
//     inconsistent with the files beside it.
//  2. The destination is ours. An explicit target must not exist and is
//     created here; the source directory, any ancestor of it, any descendant
//     of it and any symlink pointing back into it are refused. The default is
//     a fresh 0700 temp directory, because the copy contains
//     `lark_config.toml` and therefore the LLM api key.
//  3. Failure cleans up only what this run created.
//  4. Runtime state is never copied: the token, the pid file, the logs and the
//     migration lock belong to the process that made them.

import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { backupDatabase } from './db/backup.js';
import * as paths from './paths.js';

/** Never copied: state that belongs to a running process, not to the library. */
export const RUNTIME_ENTRIES = [
  'daemon-token',
  'daemon.pid',
  'logs',
  'songs.db.migrate.lock',
] as const;

/** Written by the backup itself, so the raw files are skipped by the copy. */
const DB_ENTRIES = ['songs.db', 'songs.db-wal', 'songs.db-shm'] as const;

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

  const created = await createTarget(options.target);
  try {
    await assertDisjoint(created, sourceNest);
    const targetLark = join(created, 'lark');
    await mkdir(targetLark, { recursive: false, mode: 0o700 });

    const skip = new Set<string>([...RUNTIME_ENTRIES, ...DB_ENTRIES]);
    const copied: string[] = [];
    for (const entry of await readdir(sourceLark)) {
      if (skip.has(entry)) continue;
      await cp(join(sourceLark, entry), join(targetLark, entry), {
        recursive: true,
        preserveTimestamps: true,
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
