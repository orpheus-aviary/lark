import type { LarkDatabase } from '@lark/core';
import { DEFAULT_DAEMON_PORT, type LarkConfig } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import type { EventsBus } from './events/bus.js';
import type { GuiChannel } from './events/gui-channel.js';
import type { PlayerRuntime } from './player-runtime.js';

/** Daemon package version — reported by `GET /status` and `--version`. */
export const DAEMON_VERSION = '0.1.0';

/** Loopback only. The daemon is a local service; nothing binds a public NIC. */
export const DAEMON_HOST = '127.0.0.1';

/** Default wait for a GUI ack before a player command gives up (M2-11). */
export const DEFAULT_ACK_TIMEOUT_MS = 3000;

/**
 * Structured logger, shaped like pino's `(fields, msg)` call signature — boot
 * injects the real `@lark/core` pino/pino-roll file logger; pino's Logger
 * satisfies this structurally. Tests inject a no-op / recording stub: there is
 * deliberately NO console-backed implementation here (M2-5), because the
 * log-hygiene guard forbids `console.*` in daemon source and a test helper is
 * not worth a waiver.
 */
export interface Logger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

/**
 * Shared application context passed to every route handler.
 *
 * Mutable handles (`config`, `player`) live here rather than in module state so
 * a `PATCH /config` swap or a player report is visible to every subsequent
 * request without re-building the server.
 */
export interface AppContext {
  /** The in-memory config. Replaced wholesale by a successful PATCH (M2-12). */
  config: LarkConfig;
  host: string;
  port: number;
  /** Config file path; `undefined` means "the default nest location". */
  configPath?: string;
  /** Save seam — tests inject a post-rename failure (M2-12). Defaults to core's. */
  saveConfigImpl?: (config: LarkConfig, path?: string) => void;
  /**
   * Report an unrecoverable runtime error. Idempotent and NON-WAITING: it
   * schedules teardown + `exit(1)` on a later tick and returns immediately, so
   * a route may call it and still return its own HTTP response. Awaiting it
   * from inside a request would deadlock — teardown closes the server, which
   * waits for that very request to finish (M2-1, third-review ①).
   */
  requestFatal: (err: unknown) => void;
  logger: Logger;
  db: LarkDatabase;
  sqlite: BetterSqlite3.Database;
  /** Bearer token every request but `GET /status` must carry (R21/R29). */
  localToken: string;
  eventsBus: EventsBus;
  guiChannel: GuiChannel;
  player: PlayerRuntime;
  ackTimeoutMs: number;
  version: string;
}

/** Defaults every context shares; boot and the test harness both start here. */
export const CONTEXT_DEFAULTS = {
  host: DAEMON_HOST,
  port: DEFAULT_DAEMON_PORT,
  ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
  version: DAEMON_VERSION,
} as const;
