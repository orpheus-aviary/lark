// The desktop's half of the file-effect journal (v0.2 T1b, §3.6; split from the
// deciding half in N1b, reduced to the host half in N2d).
//
// What used to be here — the drain loop, the claims, the backoff, the
// dead-lettering, and what each of the four op kinds MEANS — moved to
// `portable/sync/file-ops-runtime.ts` under decision k. Two schedulers would
// have agreed for a while and then drifted, and the way that drift shows up is
// "the same op backed off a different number of times on the phone": a symptom
// nobody traces back to a scheduler.
//
// What is left is the part that really is this host's: `rm -rf`, `rename` into
// `recovered-songs/`, and the two boot-time sweeps over that directory. The
// class stays a class with the same constructor so that its callers — the
// daemon's context, boot, `--direct` — say what they always said.

import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { StructuredLogger } from '../logger/index.js';
import { nodeFileContext } from '../node-fs.js';
import { recoveredSongsDir, songDirPath } from '../paths.js';
import type { ClaimRegistry } from '../portable/download/claims.js';
import type { SongFilesPort } from '../portable/ports/song-files.js';
import { FileEffectRuntime as PortableFileEffectRuntime } from '../portable/sync/file-ops-runtime.js';

// Desktop-only by design (this is the half that moves files), so it holds the
// desktop file context directly rather than taking one (N1c).
const files = nodeFileContext();

/**
 * `SongFilesPort` over `node:fs` (N2d).
 *
 * Every method takes a song id and hands it to `songDirPath`, which runs the
 * R10 gate before any join — the port says the adapter owes that, and this is
 * where it is paid. Quarantine targets are NAMES by contract, so they are
 * joined onto `recoveredSongsDir()` and never treated as paths: a nest that
 * moved must still resolve them.
 */
export function nodeSongFiles(): SongFilesPort {
  const quarantineDir = (target: string): string => join(recoveredSongsDir(), target);

  return {
    async songDirExists(songId) {
      return existsSync(songDirPath(songId));
    },

    async removeSongDir(songId) {
      await rm(songDirPath(songId), { recursive: true, force: true });
    },

    async quarantineExists(target) {
      return existsSync(quarantineDir(target));
    },

    async quarantineSongFile(songId, fileName, target) {
      const destination = quarantineDir(target);
      await mkdir(destination, { recursive: true });
      await rename(join(songDirPath(songId), fileName), join(destination, fileName));
    },

    async quarantineSongDir(songId, target) {
      await mkdir(recoveredSongsDir(), { recursive: true });
      await rename(songDirPath(songId), quarantineDir(target));
    },
  };
}

export interface FileEffectRuntimeOptions {
  sqlite: BetterSqlite3.Database;
  /**
   * The claim registry this process arbitrates song files with. The daemon
   * passes ITS registry so a drain cannot run while a download is replacing
   * the same song's audio; `--direct` and boot own the library alone and pass
   * a fresh one.
   */
  claims?: ClaimRegistry;
  /**
   * Claim owner. A caller that ALREADY holds a claim for the song it just
   * decided about passes its own owner, so the drain it triggers reuses that
   * claim instead of blocking on itself (a registry owner never blocks itself).
   */
  owner?: string;
  logger?: StructuredLogger;
  nowMs?: () => number;
  /**
   * Called after an op that MOVED files into `recovered-songs/` instead of
   * deleting them. The daemon turns it into an SSE event: nothing was lost,
   * but a directory nobody is told about is a directory nobody looks in.
   */
  onQuarantine?: (songId: string) => void;
}

/** The portable runtime, with this host's filesystem already in it. */
export class FileEffectRuntime extends PortableFileEffectRuntime {
  constructor(options: FileEffectRuntimeOptions) {
    super({ ...options, files, songFiles: nodeSongFiles() });
  }
}

/**
 * Drop `recovered-songs/` entries that are empty, e.g. a quarantine that
 * created its target and then crashed before the move. Boot calls this; it
 * never touches a directory with files in it.
 */
export async function pruneEmptyQuarantines(): Promise<number> {
  const root = recoveredSongsDir();
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if ((await readdir(dir)).length === 0) {
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

/** Song directories parked in `recovered-songs/`. Survives restarts by construction. */
export function countQuarantined(): number {
  const dir = recoveredSongsDir();
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}
