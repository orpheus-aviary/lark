import { homedir } from 'node:os';
import { join } from 'node:path';
import { type PathsPort, assertSongId } from './portable/ports/paths.js';

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

/**
 * The one audio file name in the library (0.3.0). Everything writes it and
 * everything reads it; there is no probing and no second format.
 */
export const CANONICAL_AUDIO_FILE = 'song.m4a';

/**
 * What 0.2.x wrote. Only two kinds of code may mention it: the one-time
 * migration, and the `has_file` probe while that migration is still pending
 * (a song not converted yet is present, and reporting it as missing would
 * offer the user a download for a file they already have).
 */
export const LEGACY_AUDIO_FILE = 'song.mp3';

/** The song lyrics file name. */
const LYRICS_FILE = 'lyrics.lrc';

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
