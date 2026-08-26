// Test harness: a real AppContext over an in-memory database, and a server
// whose `inject` carries the Bearer token by default.
//
// `buildTestServer(ctx)` is a drop-in for `buildServer(ctx)` — same Fastify
// app, so `app.inject({...})` call sites are unchanged — except that every
// injected request gets `Authorization: Bearer <ctx.localToken>`. Boundary
// tests that must send NO or a WRONG token use `app.injectRaw(...)`, the
// unpatched original; caller-supplied headers always win, so a single call can
// override the bearer inline.

import type { BilibiliClient, MediaToolsProvider, SkybridgeApi } from '@lark/core';
import {
  DEFAULT_CONFIG,
  DEFAULT_TIMEOUTS,
  DownloadEngine,
  FileEffectRuntime,
  MediaToolsRegistry,
  SyncRuntime,
  createBilibiliClient,
  createDatabase,
  nodeAudioLanding,
  nodeFileContext,
  paths,
  realSkybridgeApi,
  resolveLlmConfig,
} from '@lark/core';
import type { LarkConfig } from '@lark/shared';
import { AudioStreamRegistry } from '../audio-streams.js';
import {
  type SongLeaseOptions,
  SongLeaseRegistry,
  createEvictionScheduler,
  scheduleEvictionInBackground,
} from '../cache.js';
import {
  type AcceptanceOptions,
  type AppContext,
  CONTEXT_DEFAULTS,
  type Logger,
  createAppContext,
  installNormalRuntime,
} from '../context.js';
import { EventsBus } from '../events/bus.js';
import { GuiChannel, type GuiChannelOptions } from '../events/gui-channel.js';
import { DaemonLifecycle } from '../lifecycle.js';
import { PlayerRuntime } from '../player-runtime.js';
import { buildServer } from '../server.js';

import { type SyncHandlesOptions, attachSyncHandles } from '../sync/triggers.js';

/** Fixed token used by harness-built servers. */
export const TEST_LOCAL_TOKEN = 'test-local-token-0123456789abcdef';

export interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  msg: string;
}

export interface RecordingLogger extends Logger {
  readonly records: LogRecord[];
  /** Only the error-level lines — several tests assert this stays empty. */
  errors(): LogRecord[];
}

/**
 * Records instead of printing. There is no console-backed Logger in the daemon
 * (M2-5): `console.*` is banned by the log-hygiene guard, and a test-only
 * exception would be a hole in it.
 */
export function createRecordingLogger(): RecordingLogger {
  const records: LogRecord[] = [];
  const push = (level: LogRecord['level']) => (fields: Record<string, unknown>, msg: string) => {
    records.push({ level, fields, msg });
  };
  return {
    records,
    errors: () => records.filter((r) => r.level === 'error'),
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}

export interface TestContextOptions {
  config?: LarkConfig;
  /** Acceptance seams (M4 T6): the guard tests exercise both settings. */
  acceptance?: AcceptanceOptions;
  configPath?: string;
  saveConfigImpl?: (config: LarkConfig, path?: string) => void;
  guiChannel?: GuiChannelOptions;
  ackTimeoutMs?: number;
  /** File-backed db when a test needs one; defaults to `:memory:`. */
  dbPath?: string;
  /** Point the download engine at a fake upstream (M3). */
  engine?: Partial<ConstructorParameters<typeof DownloadEngine>[0]>;
  /**
   * Base URL for the bilibili client the ROUTES use for preflight. Tests point
   * it at the fake upstream; nothing here ever reaches the real api host.
   */
  bilibiliBase?: string;
  /** Shorten the ensure-lease TTL, or drive it off a fake clock (M5-6). */
  cacheLeases?: SongLeaseOptions;
  /**
   * Replace the media toolchain (M7-18). Defaults to a real registry over this
   * machine; pass `fakeMediaTools({unavailable: …})` to test what a machine
   * without ffmpeg answers.
   */
  mediaTools?: MediaToolsProvider;
  /**
   * The skybridge SDK surface (v0.2). Defaults to the real one, which is safe
   * precisely because nothing calls it without a session — a test that wants a
   * login passes a fake here.
   */
  skybridge?: SkybridgeApi;
  /**
   * Run the background sync triggers. OFF by default: a unit test that logs in
   * must not acquire a one-second interval timer and a server subscription as
   * a side effect. The coalescer is attached either way, so `POST /sync/run`
   * behaves the same.
   */
  syncTriggers?: boolean;
  /** Clock and jitter for the trigger tests. */
  syncHandles?: SyncHandlesOptions;
  /**
   * Boot phase to start in (0.3.0 T3). `normal` unless a test is exercising the
   * audio-migration gate — the runtime is installed either way, so a `pending`
   * context is a real daemon with the business routes closed.
   */
  lifecyclePhase?: 'pending' | 'normal';
}

export interface TestContext extends AppContext {
  logger: RecordingLogger;
  /** Everything `requestFatal` was called with — no process ever exits here. */
  readonly fatals: unknown[];
  /** Fire the shutdown signal by hand, to test what it is supposed to cut off. */
  readonly shutdownController: AbortController;
}

/** A complete context over a fresh in-memory database. */
export function createTestContext(options: TestContextOptions = {}): TestContext {
  const { db, sqlite, portable } = createDatabase({ dbPath: options.dbPath ?? ':memory:' });
  // What boot records, for the same reason (N7): the workspace this context
  // opened, which stops being the active one the moment a test switches.
  const workspace = paths.resolveActiveWorkspace().id;
  const files = nodeFileContext();
  const fatals: unknown[] = [];
  const config = options.config ?? structuredClone(DEFAULT_CONFIG);
  const eventsBus = new EventsBus();
  const shutdownController = new AbortController();
  const bilibili: BilibiliClient = createBilibiliClient(
    options.bilibiliBase === undefined ? {} : { apiBase: options.bilibiliBase },
  );
  // Real by default: the handful of route tests that transcode for real need a
  // real toolchain, and everything else never reaches it. A test that wants a
  // machine WITHOUT ffmpeg passes `fakeMediaTools({unavailable})`.
  const mediaTools = options.mediaTools ?? new MediaToolsRegistry();

  // Wired like boot's: engine callbacks are the only event source for the
  // asynchronous half of a download, so a test that asserts on SSE has to see
  // the same translation production uses.
  const downloads = new DownloadEngine({
    store: portable,
    files,
    bilibili,
    audio: nodeAudioLanding({ store: portable, mediaTools, timeouts: DEFAULT_TIMEOUTS }),
    getLlmConfig: () => resolveLlmConfig(ctx.config),
    shutdownSignal: shutdownController.signal,
    callbacks: {
      onStatus: (task) =>
        eventsBus.emit({
          type: 'download:status',
          task_id: task.id,
          state: task.state,
          stage: task.stage,
          revision: task.revision,
          received_bytes: task.received_bytes,
          total_bytes: task.total_bytes,
          title: task.title,
          artist: task.artist,
        }),
      onSucceeded: (task) => {
        if (task.result !== null) {
          eventsBus.emit({
            type: 'download:complete',
            task_id: task.id,
            song_id: task.result.song_id,
          });
        }
        if (task.kind === 'lyrics') {
          if (task.result !== null) {
            eventsBus.emit({ type: 'lyrics:changed', song_id: task.result.song_id });
          }
          return;
        }
        eventsBus.emit({ type: 'songs:changed' });
        if (task.playlist_ids.length > 0) eventsBus.emit({ type: 'playlists:changed' });
        if (task.kind === 'ensure-file' && task.result !== null) {
          ctx.cacheLeases.grant(task.result.song_id);
        }
        scheduleEvictionInBackground(ctx, 'download-succeeded');
      },
      onFailed: (task) =>
        eventsBus.emit({
          type: 'download:error',
          task_id: task.id,
          error_code: task.error_code ?? 'INTERNAL_ERROR',
          message: task.error_message ?? 'download failed',
        }),
      onCancelled: (task) => eventsBus.emit({ type: 'download:cancelled', task_id: task.id }),
      onBatchesChanged: (batchId) =>
        eventsBus.emit({ type: 'download:batches-changed', batch_id: batchId }),
    },
    ...options.engine,
  });

  const ctx = createAppContext({
    ...CONTEXT_DEFAULTS,
    workspace,
    config,
    configPath: options.configPath,
    saveConfigImpl: options.saveConfigImpl,
    ackTimeoutMs: options.ackTimeoutMs ?? CONTEXT_DEFAULTS.ackTimeoutMs,
    requestFatal: (err: unknown) => {
      fatals.push(err);
    },
    logger: createRecordingLogger(),
    db,
    sqlite,
    portable,
    files,
    localToken: TEST_LOCAL_TOKEN,
    eventsBus,
    guiChannel: new GuiChannel(options.guiChannel),
    mediaTools,
    bilibili,
    skybridge: options.skybridge ?? realSkybridgeApi,
    shutdownSignal: shutdownController.signal,
    // Default `normal`: an in-memory library owes no conversion, and every
    // pre-0.3 test would otherwise be talking to a gated daemon. The migration
    // tests pass 'pending' and drive the phase themselves.
    lifecycle: new DaemonLifecycle(options.lifecyclePhase ?? 'normal'),
    ...(options.acceptance === undefined ? {} : { acceptance: options.acceptance }),
    fatals,
    shutdownController,
  }) as TestContext;

  installNormalRuntime(ctx, {
    player: new PlayerRuntime(),
    audioStreams: new AudioStreamRegistry(),
    cacheLeases: new SongLeaseRegistry(options.cacheLeases),
    cacheScheduler: createEvictionScheduler(ctx),
    downloads,
    sync: new SyncRuntime({ triggers: options.syncTriggers === true }),
    fileOps: new FileEffectRuntime({
      sqlite,
      claims: downloads.claims,
      onQuarantine: (songId) => eventsBus.emit({ type: 'sync:file_quarantined', song_id: songId }),
    }),
  });
  attachSyncHandles(ctx, options.syncHandles ?? {});
  return ctx;
}

/**
 * Release everything a test context owns (mirrors boot's teardown order).
 *
 * Async since M3: `downloads.close()` waits for the worker to exit and for any
 * ffmpeg child to be reaped. Every `afterEach` must await it — a missed await
 * shows up as a handle leak under the fork pool, not as a failing assertion.
 */
export async function closeTestContext(ctx: TestContext): Promise<void> {
  ctx.player.failAll({ kind: 'shutting-down' });
  // Mirrors boot's teardown: the sync timers and any round in flight go before
  // the database they hold a handle to (§3.11).
  ctx.sync.stopHandles();
  await ctx.sync.teardownSession();
  await ctx.downloads.close();
  // Same reason as boot's teardown: a drain in flight would otherwise wake up
  // on a closed events bus and a closed database (M5-6).
  await ctx.cacheScheduler.close();
  ctx.guiChannel.close();
  ctx.eventsBus.close();
  ctx.sqlite.close();
}

type BaseApp = ReturnType<typeof buildServer>;
export type TestApp = BaseApp & { injectRaw: BaseApp['inject'] };

export function buildTestServer(ctx: AppContext): TestApp {
  const app = buildServer(ctx) as TestApp;
  app.injectRaw = app.inject.bind(app);

  const raw = app.injectRaw;
  const token = ctx.localToken;
  // Only the object form is wrapped (every daemon test uses `inject({...})`).
  app.inject = ((opts: { headers?: Record<string, unknown> }) =>
    raw({
      ...opts,
      headers: { authorization: `Bearer ${token}`, ...opts?.headers },
    })) as BaseApp['inject'];

  return app;
}
