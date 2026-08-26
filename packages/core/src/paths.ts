import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CANONICAL_AUDIO_FILE,
  LEGACY_AUDIO_FILE,
  LYRICS_FILE,
  type PathsPort,
  assertSongId,
} from './portable/ports/paths.js';
import { WORKSPACE_LOCAL, isWorkspaceId } from './portable/workspace.js';

const NEST_DIR = 'orpheus-aviary-nest';
const LARK_DIR = 'lark';
const LIBRARIES_DIR = 'libraries';

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
 * prefix is named here for the same reason the others are: the backup has to
 * recognise a file caught mid-rename.
 */
export const WORKSPACES_FILE_NAME = 'workspaces.toml';
export const WORKSPACES_TEMP_PREFIX = '.workspaces.toml.tmp-';

export function workspacesPath(): string {
  return join(larkDir(), WORKSPACES_FILE_NAME);
}

/** `lark/libraries/` — the parent of every account workspace. */
export function librariesDir(): string {
  return join(larkDir(), LIBRARIES_DIR);
}

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
export function workspacePaths(id: string): WorkspacePaths {
  if (!isWorkspaceId(id)) throw new Error(`not a workspace id: ${id}`);
  const root = id === WORKSPACE_LOCAL ? larkDir() : join(librariesDir(), id);
  return {
    root,
    db: join(root, 'songs.db'),
    songs: join(root, 'songs'),
    trash: join(root, 'trash'),
    recoveredSongs: join(root, 'recovered-songs'),
    migrationBackup: join(root, 'migration-backup'),
    skybridgeConfig: join(root, SKYBRIDGE_FILE_NAME),
  };
}

/** SQLite database: `lark/songs.db` (schema lands in M1). */
export function dbPath(): string {
  return join(larkDir(), 'songs.db');
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

/** Log directory: `lark/logs/` */
export function logsDir(): string {
  return join(larkDir(), 'logs');
}

/** Rolling log file: `lark/logs/lark.log` (pino-roll lands in M1). */
export function larkLogPath(): string {
  return join(logsDir(), 'lark.log');
}

/** Song payload root: `lark/songs/` — one `<uuid>/` directory per song. */
export function songsDir(): string {
  return join(larkDir(), 'songs');
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

/** Trash staging dir for deleteSong's two-phase delete (R22): `lark/trash/` */
export function trashDir(): string {
  return join(larkDir(), 'trash');
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
  return join(larkDir(), 'recovered-songs');
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
  return join(larkDir(), 'migration-backup');
}

/** Aviary shared config, the LLM fallback source: `aviary/aviary_config.toml` */
export function aviaryConfigPath(): string {
  return join(nestDir(), 'aviary', 'aviary_config.toml');
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

export function skybridgeConfigPath(): string {
  return join(larkDir(), SKYBRIDGE_FILE_NAME);
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
