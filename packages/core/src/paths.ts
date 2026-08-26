import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACES_FILE_NAME, readWorkspaceIndex } from './config/workspaces.js';
import type { StructuredLogger } from './portable/logger.js';
import {
  CANONICAL_AUDIO_FILE,
  LEGACY_AUDIO_FILE,
  LYRICS_FILE,
  type PathsPort,
  assertSongId,
} from './portable/ports/paths.js';
import { type ActiveWorkspaceVerdict, decideActiveWorkspace } from './portable/workspace-index.js';
import { LIBRARIES_DIRECTORY, WORKSPACE_LOCAL, workspaceSegments } from './portable/workspace.js';

const NEST_DIR = 'orpheus-aviary-nest';
const LARK_DIR = 'lark';

/**
 * Root data directory.
 *
 * Honors the `LARK_NEST_DIR` env override so tests and throwaway instances can
 * run against an isolated nest. Re-evaluated on every call — tests flip the env
 * between assertions without module-state reset gymnastics.
 *
 * Fallback: `~/orpheus-aviary-nest/`.
 */
export function nestDir(): string {
  const override = process.env.LARK_NEST_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), NEST_DIR);
}

/** lark data directory: `~/orpheus-aviary-nest/lark/` */
export function larkDir(): string {
  return join(nestDir(), LARK_DIR);
}

/** Config file: `lark/lark_config.toml` (loader lands in M1). */
export function configPath(): string {
  return join(larkDir(), 'lark_config.toml');
}

// ─── Workspaces (N7b) ───────────────────────────────────
//
// One device, several libraries. The nest splits in two:
//
//   lark/                        DEVICE — one per install
//   ├── lark_config.toml         settings, logs, the daemon's token and pid
//   ├── workspaces.toml          which workspace this device opens
//   ├── songs.db · songs/ · …    the `local` workspace, in place
//   └── libraries/<32hex>/       one account workspace each
//       └── songs.db · songs/ · skybridge.toml · …
//
// `local` LIVES AT THE ROOT and that is the whole migration story (§2.4): a
// library that was already there simply is the local workspace, byte for byte,
// with nothing moved. Same shape owl chose, for the same reason — the pure
// local user pays nothing for a feature they are not using.
//
// Credentials go INSIDE the workspace rather than staying at the nest root,
// which is the one place lark's layout differs from owl's: a workspace's
// session belongs to that workspace, and keeping them together means the db
// existing and the credentials existing cannot disagree.

/**
 * The device's workspace index: `lark/workspaces.toml`.
 *
 * Not credential material — it holds an id, a label and a server url — so
 * unlike `skybridge.toml` it is 0644 and a nest backup keeps it. The temp
 * prefix is re-exported here for the same reason the others are named here:
 * the backup has to recognise a file caught mid-rename.
 */
export { WORKSPACES_FILE_NAME, WORKSPACES_TEMP_PREFIX } from './config/workspaces.js';

export function workspacesPath(): string {
  return join(larkDir(), WORKSPACES_FILE_NAME);
}

/** `lark/libraries/` — the parent of every account workspace. */
export function librariesDir(): string {
  return join(larkDir(), LIBRARIES_DIRECTORY);
}

/**
 * skybridge credentials (v0.2, D1/D2): `lark/skybridge.toml`, mode 0600.
 *
 * Deliberately NOT part of `lark_config.toml`: that file goes through
 * `GET /config` and `PATCH /config`, and a bearer token has no business on a
 * channel whose whole job is to be read and edited. It also has to be
 * excluded from a nest backup — a backup is disaster recovery, not a clone,
 * and a second machine restoring one would come up holding this machine's
 * device identity (§4.5). The temp prefix is named here for the same reason
 * the skill one is: the backup has to recognise a file caught mid-rename.
 */
export const SKYBRIDGE_FILE_NAME = 'skybridge.toml';
export const SKYBRIDGE_TEMP_PREFIX = '.skybridge.toml.tmp-';

// The names, spelled once each, because two consumers need them: the layout
// below and the one-time migration that moves them (`workspace-migrate.ts`).
const DB_FILE = 'songs.db';
const SONGS_SUBDIR = 'songs';
const TRASH_SUBDIR = 'trash';
const RECOVERED_SUBDIR = 'recovered-songs';
const MIGRATION_BACKUP_SUBDIR = 'migration-backup';

/**
 * What the one-time migration moves, by basename, in the order it moves them.
 *
 * The database FIRST, deliberately: it is the entry whose absence any other
 * process notices, so once it is at the new home a reader that somehow got
 * past both locks opens the new library rather than an empty root.
 *
 * 🔴 THE WAL SIDECARS ARE NOT HERE, and leaving them out is not an oversight —
 * it is the fix for a real wedge (N7c). `songs.db-wal` and `songs.db-shm`
 * belong to one database file, they cannot be renamed together with it
 * atomically, and ANY read-only connection to a WAL database creates a fresh
 * pair and does not remove them on close (M6 measured this in the backup). So
 * a crash mid-move plus one curious reader is enough to make a sidecar exist
 * at BOTH ends, and a mover that refuses to overwrite would then never
 * converge. The migration checkpoints the database and closes it instead,
 * which leaves nothing to move.
 *
 * The two lock databases are not here either. They are per-machine fcntl
 * state, one of them is held while a migration runs, and the rule since M6 is
 * that a lock file is never deleted — a fresh pair appears at the new home on
 * first use.
 */
export const WORKSPACE_ENTRIES = [
  DB_FILE,
  SONGS_SUBDIR,
  SKYBRIDGE_FILE_NAME,
  TRASH_SUBDIR,
  RECOVERED_SUBDIR,
  MIGRATION_BACKUP_SUBDIR,
] as const;

/**
 * The two names anything building a workspace from scratch needs.
 *
 * Exported so that `workspace-prepare.ts` can name them without spelling
 * `songs.db` — which `check-workspace-chokepoint.sh` forbids everywhere but
 * here, and rightly: a second spelling is how a process ends up opening the
 * nest root while the library lives somewhere else.
 */
export const WORKSPACE_DB_FILE = DB_FILE;
export const WORKSPACE_SONGS_SUBDIR = SONGS_SUBDIR;

/** The sidecars a WAL database keeps beside it. Checkpointed away, never moved. */
export const DB_SIDECARS = [`${DB_FILE}-wal`, `${DB_FILE}-shm`] as const;

/** Everything one workspace owns. The device's files are deliberately absent. */
export interface WorkspacePaths {
  root: string;
  db: string;
  songs: string;
  trash: string;
  recoveredSongs: string;
  migrationBackup: string;
  skybridgeConfig: string;
}

/**
 * Where a workspace's files are, by id.
 *
 * The id gate runs before the join for the same reason `songDirPath`'s does:
 * an id that reaches a path unvalidated is a traversal, and this one can
 * arrive from a file somebody edited by hand.
 */
export function workspacePaths(id: string, larkDirPath: string = larkDir()): WorkspacePaths {
  // The layout — and the id gate in front of it — is `portable/workspace.ts`'s,
  // so the phone joins the same segments onto its own idea of a directory.
  const root = join(larkDirPath, ...workspaceSegments(id));
  return {
    root,
    db: join(root, DB_FILE),
    songs: join(root, SONGS_SUBDIR),
    trash: join(root, TRASH_SUBDIR),
    recoveredSongs: join(root, RECOVERED_SUBDIR),
    migrationBackup: join(root, MIGRATION_BACKUP_SUBDIR),
    skybridgeConfig: join(root, SKYBRIDGE_FILE_NAME),
  };
}

// ─── The resolver: which workspace does THIS process open (N7c) ─────────────
//
// One chokepoint, and it is the path functions themselves. Every entry point
// that opens a library — daemon boot, `lark --direct`, the GUI's precheck —
// reaches it through `dbPath()`, so there is no "old path" left to bypass it
// to: `lark/songs.db` is reachable only as `workspacePaths(WORKSPACE_LOCAL).db`
// and `scripts/check-workspace-chokepoint.sh` is what keeps it that way.
//
// THE GATE IS TWO QUESTIONS, not owl's three (`workspace-index.ts` says why
// the third has nothing left to catch):
//
//   ① `active` is a workspace id this build understands
//   ② its `songs.db` is on disk
//
// Either one failing means `local`. Falling back rather than failing is the
// conservative direction and it is worth being explicit about which way that
// cuts: a device whose real library is under `libraries/` and whose index went
// missing comes up on an EMPTY local library, which looks alarming and loses
// nothing — while the alternative, creating a library at the missing path,
// would put new songs somewhere the user cannot find. Nothing is deleted
// either way, and `verdict.fellBack` is what the daemon logs so it is a
// sentence in the log rather than a mystery.
//
// CACHED PER NEST, because switching workspaces is a restart (§2.5): the
// answer cannot change inside a process except when THIS process migrates or
// switches, and both call `invalidateActiveWorkspace()`. Keyed on `larkDir()`
// so a test that moves `LARK_NEST_DIR` between assertions gets a fresh answer
// without reaching for module-state gymnastics — the same promise every other
// function in this file makes.

/** The gate's verdict. The type and the gate itself are portable — the phone
 * runs the same two questions. */
export type ActiveWorkspace = ActiveWorkspaceVerdict;

let cached: { larkDir: string; active: ActiveWorkspace } | null = null;

function judgeActiveWorkspace(root: string, logger?: StructuredLogger): ActiveWorkspace {
  const index = readWorkspaceIndex(join(root, WORKSPACES_FILE_NAME), logger);
  const verdict = decideActiveWorkspace(index, (id) =>
    existsSync(join(root, ...workspaceSegments(id), DB_FILE)),
  );
  if (verdict.fellBack) {
    logger?.warn(
      { requested: verdict.requested },
      `the active workspace has no library on disk — opening '${WORKSPACE_LOCAL}' instead`,
    );
  }
  return verdict;
}

/**
 * The same verdict, for a nest that is not this process's.
 *
 * `resolveActiveWorkspace()` reads `LARK_NEST_DIR`, which is right for a
 * daemon and wrong for anything driving two nests at once — the acceptance
 * harnesses and the two-device e2e both do. Uncached, because the caller owns
 * the lifetime of whatever it is pointing at.
 */
export function activeWorkspaceIn(larkDirPath: string, logger?: StructuredLogger): ActiveWorkspace {
  return judgeActiveWorkspace(larkDirPath, logger);
}

/** Where that nest's library actually is. The one-liner every harness wants. */
export function activeWorkspaceRootIn(larkDirPath: string): string {
  return workspacePaths(activeWorkspaceIn(larkDirPath).id, larkDirPath).root;
}

/** The verdict, with the reason attached. Cached for the life of the process. */
export function resolveActiveWorkspace(logger?: StructuredLogger): ActiveWorkspace {
  const root = larkDir();
  if (cached?.larkDir === root) return cached.active;
  const active = judgeActiveWorkspace(root, logger);
  cached = { larkDir: root, active };
  return active;
}

/**
 * Forget the verdict.
 *
 * TWO real callers, and both of them have just changed the answer: the
 * one-time migration (§2.3) and a switch that is about to restart anyway.
 * Tests use it for the third reason — writing an index into a nest they have
 * already read from.
 */
export function invalidateActiveWorkspace(): void {
  cached = null;
}

/** Where the active workspace keeps its files. */
export function activeWorkspacePaths(): WorkspacePaths {
  return workspacePaths(resolveActiveWorkspace().id);
}

/**
 * SQLite database: the ACTIVE workspace's `songs.db`.
 *
 * `lark/songs.db` for `local` — where it has always been — and
 * `lark/libraries/<id>/songs.db` for an account. Every caller that opens the
 * library goes through here, which is what makes the resolver a chokepoint
 * rather than a convention.
 */
export function dbPath(): string {
  return activeWorkspacePaths().db;
}

/**
 * The daemon's 0600 local-token file (M2). Generated in memory by the daemon
 * and atomically published only after `listen()` succeeds, so a losing
 * instance can never clobber the running daemon's token (R29).
 */
export function localTokenPath(): string {
  return join(larkDir(), 'daemon-token');
}

/** The daemon's PID lock file (M2). */
export function pidPath(): string {
  return join(larkDir(), 'daemon.pid');
}

/**
 * The workspace-switch lock: `lark/workspace-switch.lock` (N7c).
 *
 * Device-level, like the pid file beside it, because what it protects is the
 * DEVICE's layout: the one-time migration and a login that copies a whole
 * library into a new workspace both spend seconds with a library half where it
 * is going. A `lark --direct` in that window would open it.
 *
 * The temp suffix is named here for the same reason the others are — a backup
 * has to recognise a file caught mid-rename, and this one is pure runtime
 * state that a copy must not carry at all.
 */
export const SWITCH_LOCK_FILE_NAME = 'workspace-switch.lock';
export const SWITCH_LOCK_TEMP_PREFIX = '.workspace-switch.lock.tmp-';

export function switchLockPath(): string {
  return join(larkDir(), SWITCH_LOCK_FILE_NAME);
}

/** Log directory: `lark/logs/` */
export function logsDir(): string {
  return join(larkDir(), 'logs');
}

/** Rolling log file: `lark/logs/lark.log` (pino-roll lands in M1). */
export function larkLogPath(): string {
  return join(logsDir(), 'lark.log');
}

/** Song payload root: the active workspace's `songs/`, one `<uuid>/` per song. */
export function songsDir(): string {
  return activeWorkspacePaths().songs;
}

// The three file names are declared with the `PathsPort` (N1e, N2d): portable
// code needs them and cannot import this file. Re-exported here because this
// is where the desktop has always read them from.
export { CANONICAL_AUDIO_FILE, LEGACY_AUDIO_FILE };

/**
 * The desktop's `PathsPort` (N1a).
 *
 * The id gate runs before any join, exactly as it always has (R10) —
 * `songs/<id>/` is a real location and an id that reaches a join unvalidated
 * is a traversal waiting to happen. `library/lyrics.ts` delegates its path
 * functions here, so there is ONE implementation rather than two that agree
 * until they don't.
 */
export function nodePaths(): PathsPort {
  const songDir = (id: string): string => {
    assertSongId(id);
    return join(songsDir(), id);
  };
  return {
    songDir,
    songAudio: (id) => join(songDir(id), CANONICAL_AUDIO_FILE),
    songLegacyAudio: (id) => join(songDir(id), LEGACY_AUDIO_FILE),
    songLyrics: (id) => join(songDir(id), LYRICS_FILE),
  };
}

/**
 * A `PathsPort` for ONE workspace, whichever one is active (N7e).
 *
 * `nodePaths()` answers for the active workspace and is what the daemon
 * serves from. This one is for the login that installs into a workspace this
 * process is NOT serving: the backfill reads lyrics off disk, and it has to
 * read the target's, not the current library's.
 */
export function workspacePathsPort(id: string, larkDirPath: string = larkDir()): PathsPort {
  const songs = workspacePaths(id, larkDirPath).songs;
  const songDir = (songId: string): string => {
    assertSongId(songId);
    return join(songs, songId);
  };
  return {
    songDir,
    songAudio: (songId) => join(songDir(songId), CANONICAL_AUDIO_FILE),
    songLegacyAudio: (songId) => join(songDir(songId), LEGACY_AUDIO_FILE),
    songLyrics: (songId) => join(songDir(songId), LYRICS_FILE),
  };
}

/** Trash staging dir for deleteSong's two-phase delete (R22): `<workspace>/trash/` */
export function trashDir(): string {
  return activeWorkspacePaths().trash;
}

/**
 * Where files rescued from a remote delete land: `lark/recovered-songs/`.
 *
 * Sync may tell this device that a song is gone. Its audio can be re-fetched
 * from `source_key`, but an IMPORTED file cannot — it only ever existed here.
 * So a remote delete moves what it cannot replace into this directory instead
 * of unlinking it, and `/sync/status` keeps counting what is in here so the
 * pile stays visible rather than becoming a surprise at backup time (§3.6).
 */
export function recoveredSongsDir(): string {
  return activeWorkspacePaths().recoveredSongs;
}

/**
 * Where the audio migration keeps what it converted but must not delete:
 * `lark/migration-backup/` (0.3.0, master plan §3.2-1).
 *
 * Outside the `songs/` tree on purpose. Everything in there is by definition
 * a file the migration could not prove it could get back — an imported song,
 * or one whose source no longer answers — so it must not be reachable by the
 * cache eviction (which walks the library), by sync (which sees songs), or by
 * the startup recovery (which walks `songs/`). A nest backup DOES include it,
 * and the settings page shows what it costs with a way to empty it: an
 * invisible pile of bytes growing under a user's home directory is the thing
 * this layout exists to avoid.
 */
export function migrationBackupDir(): string {
  return activeWorkspacePaths().migrationBackup;
}

/** Aviary shared config, the LLM fallback source: `aviary/aviary_config.toml` */
export function aviaryConfigPath(): string {
  return join(nestDir(), 'aviary', 'aviary_config.toml');
}

export function skybridgeConfigPath(): string {
  return activeWorkspacePaths().skybridgeConfig;
}

/**
 * `lark skill export`'s default output and the fixed prefix of its
 * same-directory temp files (M6-14).
 *
 * Named here rather than in the command, because the backup has to recognise
 * both: a generated skill file is not library data — it can be re-exported at
 * any time — and a temp file caught mid-rename is not even a whole document.
 */
export const SKILL_FILE_NAME = 'lark-skill.md';
export const SKILL_TEMP_PREFIX = '.lark-skill.md.tmp-';

/** Default skill export target: `lark/lark-skill.md` */
export function skillPath(): string {
  return join(larkDir(), SKILL_FILE_NAME);
}

// The three song paths as plain functions, for the desktop code that is not
// going anywhere: the journal executor, the download landing protocol, the
// audio migration, the media route. Portable code takes a `PathsPort` instead
// — same implementation underneath, since these delegate to it (N1c).
const songPaths = nodePaths();

/** `songs/<id>/` — throws InvalidIdError before touching the filesystem. */
export function songDirPath(id: string): string {
  return songPaths.songDir(id);
}

/** `songs/<id>/song.m4a` */
export function songAudioPath(id: string): string {
  return songPaths.songAudio(id);
}

/** `songs/<id>/lyrics.lrc` */
export function songLyricsPath(id: string): string {
  return songPaths.songLyrics(id);
}
