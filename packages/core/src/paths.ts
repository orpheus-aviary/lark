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
