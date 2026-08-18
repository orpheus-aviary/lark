// The filesystem, as the portable half of core uses it (N1a, subplan §2.4).
//
// The surface is the USED surface, not a filesystem abstraction: five calls,
// each with a caller named in the subplan. Anything the desktop does that no
// portable module needs — the journal executor's quarantine moves, backups,
// lock files — stays in core proper, where it can keep using `node:fs`.
//
// Two rules hold for every implementation:
//
//   "Not there" is a RETURN VALUE, never an exception. Every caller today
//   distinguishes absence from failure by catching ENOENT and rethrowing the
//   rest, and an adapter that faked Node's errno codes on another host would
//   be inventing a contract out of one host's error strings.
//
//   Everything else throws the HOST's error, unchanged. A permission error is
//   not core's to translate, and swallowing it would turn "your library is
//   unreadable" into "you have no songs".

import type { PathsPort } from './paths.js';

export interface FileStat {
  size: number;
}

export interface FileSystemPort {
  /**
   * Size, or `null` when there is no such file.
   *
   * Synchronous because its callers are: cache eviction re-stats inside a
   * delete critical section that must contain no `await` (M5), and
   * `songFileInfo` answers a wire field from a live disk probe.
   */
  statSync(path: string): FileStat | null;

  /** Delete. `false` = there was nothing there. Synchronous, same reason. */
  unlinkSync(path: string): boolean;

  /** UTF-8 contents, or `null` when there is no such file. */
  readText(path: string): Promise<string | null>;

  /**
   * Replace a file's contents so that a reader NEVER sees a partial write:
   * a temp file in the SAME directory, then an atomic rename over the target.
   * Parent directories are created as needed.
   *
   * This is a high-level operation rather than open/write/rename precisely so
   * the guarantee is one thing an adapter has to provide, not three things it
   * has to assemble correctly. It is load bearing for lyrics, which are the
   * one document in the library that cannot be re-downloaded (R1/R26) — and
   * the local write path is a DIRECT write, not a journalled one, so there is
   * no second mechanism underneath to repair a half-written file.
   *
   * If a host cannot do this, that is a decision to bring back for a ruling —
   * not something an adapter quietly weakens (subplan §2.4).
   *
   * The temp file's NAME is the adapter's business with one constraint: a host
   * whose recovery sweeps residue by prefix has to keep producing names that
   * sweep recognises. The desktop writes `.<basename>.<uuid>.tmp` for exactly
   * that reason.
   */
  writeTextAtomic(path: string, text: string): Promise<void>;

  /** Delete. `false` = there was nothing there. */
  unlink(path: string): Promise<boolean>;
}

/**
 * Files as ONE capability, passed explicitly.
 *
 * A path without the filesystem that resolves it is half an answer, and the
 * pair travelling as a module global is how a host leaks into code that is
 * supposed to be portable. So both arrive together, as a field of whatever
 * context the caller already receives — the coordinator's, the library
 * service's, the download engine's (subplan §2.2, third-review revision).
 */
export interface FileContext {
  fs: FileSystemPort;
  paths: PathsPort;
}
