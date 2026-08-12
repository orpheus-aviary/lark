import { homedir } from 'node:os';
import { join } from 'node:path';

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
