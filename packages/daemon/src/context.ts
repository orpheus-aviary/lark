import type {
  BilibiliClient,
  DownloadEngine,
  FileEffectRuntime,
  LarkDatabase,
  MediaToolsProvider,
} from '@lark/core';
import { DEFAULT_DAEMON_PORT, type LarkConfig } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import type { AudioStreamRegistry } from './audio-streams.js';
import type { EvictionScheduler, SongLeaseRegistry } from './cache.js';
import type { EventsBus } from './events/bus.js';
import type { GuiChannel } from './events/gui-channel.js';
import type { DaemonLifecycle } from './lifecycle.js';
import type { PlayerRuntime } from './player-runtime.js';
import type { SyncRuntime } from './sync/runtime.js';
import { DAEMON_VERSION } from './version.js';

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
 * Everything that exists from the daemon's first tick (0.3.0 T3, §3.2-3).
 *
 * The dividing line is not "cheap to build" but "what a WHITELISTED handler
 * needs": during the audio migration the socket is open, `/status`,
 * `/api/capabilities`, `/events` and the file-op trio answer, and every one of
 * those reaches into this object. Anything they touch has to be here, or the
 * migration screen would be talking to a daemon that cannot describe itself.
 *
 * `bilibili` is here for a second reason: the migration's discard step probes
 * the source before deleting an mp3, and that probe is the cache eviction's own
 * (R26 — one implementation, not two). A second client would present a second
 * identity to risk control from the same process, so the one client predates
 * the runtime that usually owns it.
 */
export interface BaseContext {
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
  /**
   * ONE media toolchain for the whole daemon (M7-18): before this,
   * `GET /api/capabilities` and the download engine resolved ffmpeg
   * independently, so the daemon could report "no ffmpeg" in one breath and
   * transcode through Homebrew in the next. Everything that spawns ffmpeg or
   * ffprobe goes through this — the migration pass included.
   */
  mediaTools: MediaToolsProvider;
  /**
   * ONE bilibili client for the whole daemon, shared by the routes' preflight,
   * the engine's worker and the migration probe. Sharing it is not just
   * tidiness: the client caches the WBI keys and the anonymous buvid, and a
   * second client would be a second identity to risk control.
   */
  bilibili: BilibiliClient;
  /**
   * Aborted when the daemon starts stopping (M3-13).
   *
   * Every long-running operation a HANDLER performs — a preflight fetch, a
   * fetch-list walk, an import's ffprobe — must compose this into its signal.
   * Those are not engine work, so `downloads.close()` cannot cancel them, and
   * `server.close()` waits for in-flight requests: without this a Ctrl-C waits
   * out the longest timeout in the matrix.
   */
  shutdownSignal: AbortSignal;
  ackTimeoutMs: number;
  version: string;
  /** Boot phase machine, and the migration pass while there is one (§3.2-3). */
  lifecycle: DaemonLifecycle;
  /**
   * ACCEPTANCE-ONLY seams (M4 T6). Undefined in every normal boot: the shipped
   * CLI has no switch for them and only `testing/boot-child.ts` reads the env
   * that turns them on — the same containment M2 used for its test knobs.
   */
  acceptance?: AcceptanceOptions;
}

/**
 * The half that only exists once the library is served (0.3.0 T3).
 *
 * Late-bound: during the audio migration none of this is built, because none of
 * it would be allowed to run. Reading one of these fields before activation
 * throws `RuntimeNotReadyError` rather than yielding `undefined` — the request
 * gate makes that unreachable, and a loud failure is how a hole in the gate
 * announces itself instead of turning into "cannot read property of undefined"
 * three frames deeper.
 */
export interface NormalRuntime {
  player: PlayerRuntime;
  /**
   * Open `GET /audio` streams per song (M5-5). Context-level rather than a
   * module global: eviction asks it whether a specific song is being read
   * right now, and a global would let one test context (or a second daemon in
   * the same process) answer for another's songs.
   */
  audioStreams: AudioStreamRegistry;
  /** Short-lived eviction immunity for freshly ensured files (M5-6). */
  cacheLeases: SongLeaseRegistry;
  /**
   * The single eviction driver. Boot, a finished download and
   * `POST /cache/evict` all schedule through this one instance — two would
   * defeat the single-flight and run concurrent drains over the same files.
   */
  cacheScheduler: EvictionScheduler;
  /** The download queue (M3). Always present — an unconfigured LLM only
   * narrows what it can do, it never makes the engine unavailable. */
  downloads: DownloadEngine;
  /**
   * The skybridge session and everything serialized around it (v0.2 §3.11).
   *
   * Always present, even on an install that has never logged in: "there is no
   * session" is a state this object reports, not an absence a caller has to
   * guess at. It owns the epoch and the lifecycle mutex, so login, logout, a
   * token refresh and unbind cannot interleave.
   */
  sync: SyncRuntime;
  /**
   * The file-effect journal's executor (§3.6).
   *
   * Shares the download engine's claim registry, which is the whole point of
   * there being ONE per daemon: a drain that deletes a song's directory must
   * not run while a download is replacing that song's audio, and two registries
   * would arbitrate two different sets of claims over the same files.
   */
  fileOps: FileEffectRuntime;
}

/**
 * Shared application context passed to every route handler.
 *
 * Mutable handles (`config`, `player`) live here rather than in module state so
 * a `PATCH /config` swap or a player report is visible to every subsequent
 * request without re-building the server.
 */
export type AppContext = BaseContext & NormalRuntime;

export interface AcceptanceOptions {
  /**
   * Pace `/audio` writes. The media criteria need a seek to land on bytes
   * that are genuinely not buffered yet, and a local file over loopback is
   * fully buffered long before a human (or a script) can drag the slider.
   */
  audioThrottleBytesPerSec?: number;
  /**
   * Register `GET /debug/audio-streams`. Deliberately NOT in the capabilities
   * list: it is an observation point for the stream-leak criterion, not part
   * of the API, and a guard test asserts it 404s in a normal boot.
   */
  debugRoutes?: boolean;
}

/** Reading a late-bound runtime handle before it exists (0.3.0 T3). */
export class RuntimeNotReadyError extends Error {
  override readonly name = 'RuntimeNotReadyError';
  constructor(field: string) {
    super(`daemon runtime is not active yet (asked for "${field}")`);
  }
}

const NORMAL_RUNTIME_KEYS = [
  'player',
  'audioStreams',
  'cacheLeases',
  'cacheScheduler',
  'downloads',
  'sync',
  'fileOps',
] as const satisfies readonly (keyof NormalRuntime)[];

/** Defaults every context shares; boot and the test harness both start here. */
export const CONTEXT_DEFAULTS = {
  host: DAEMON_HOST,
  port: DEFAULT_DAEMON_PORT,
  ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
  version: DAEMON_VERSION,
} as const;

/**
 * Which context has which runtime. Off the object on purpose: everything on a
 * context is enumerable and gets spread, logged and shallow-copied, and this is
 * a handle to the daemon's engines — not data.
 */
const RUNTIMES = new WeakMap<BaseContext, NormalRuntime>();

/**
 * Build the object every handler is given.
 *
 * The identity is fixed here and never replaced: Fastify handlers close over it
 * at registration, and registration happens before `listen()` (Fastify 5 throws
 * on a route added afterwards). So the normal runtime is swapped INTO this
 * object rather than the object being rebuilt around it.
 */
export function createAppContext<T extends BaseContext>(base: T): T & NormalRuntime {
  const ctx = { ...base } as T & NormalRuntime;
  for (const key of NORMAL_RUNTIME_KEYS) {
    Object.defineProperty(ctx, key, {
      enumerable: true,
      configurable: false,
      get() {
        const runtime = RUNTIMES.get(ctx);
        if (runtime === undefined) throw new RuntimeNotReadyError(key);
        return runtime[key];
      },
    });
  }
  return ctx;
}

/** Swap the built runtime in. One call — `beginActivation` guards the rest. */
export function installNormalRuntime(ctx: AppContext, runtime: NormalRuntime): void {
  RUNTIMES.set(ctx, runtime);
}

/**
 * The runtime if it is there, null otherwise.
 *
 * For teardown and for the handful of places that legitimately run in both
 * phases: stopping a daemon that never activated must not throw its way out of
 * the release sequence.
 */
export function peekNormalRuntime(ctx: BaseContext): NormalRuntime | null {
  return RUNTIMES.get(ctx) ?? null;
}
