// Test harness: a real AppContext over an in-memory database, and a server
// whose `inject` carries the Bearer token by default.
//
// `buildTestServer(ctx)` is a drop-in for `buildServer(ctx)` — same Fastify
// app, so `app.inject({...})` call sites are unchanged — except that every
// injected request gets `Authorization: Bearer <ctx.localToken>`. Boundary
// tests that must send NO or a WRONG token use `app.injectRaw(...)`, the
// unpatched original; caller-supplied headers always win, so a single call can
// override the bearer inline.

import type { BilibiliClient, MediaToolsProvider } from '@lark/core';
import {
  DEFAULT_CONFIG,
  DownloadEngine,
  MediaToolsRegistry,
  createBilibiliClient,
  createDatabase,
  resolveLlmConfig,
} from '@lark/core';
import type { LarkConfig } from '@lark/shared';
import { AudioStreamRegistry } from '../audio-streams.js';
import {
  type SongLeaseOptions,
  SongLeaseRegistry,
  scheduleEvictionInBackground,
  withEvictionScheduler,
} from '../cache.js';
import {
  type AcceptanceOptions,
  type AppContext,
  CONTEXT_DEFAULTS,
  type Logger,
} from '../context.js';
import { EventsBus } from '../events/bus.js';
import { GuiChannel, type GuiChannelOptions } from '../events/gui-channel.js';
import { PlayerRuntime } from '../player-runtime.js';
import { buildServer } from '../server.js';

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
  const { db, sqlite } = createDatabase({ dbPath: options.dbPath ?? ':memory:' });
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
    db,
    sqlite,
    bilibili,
    mediaTools,
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

  const ctx: TestContext = withEvictionScheduler({
    ...CONTEXT_DEFAULTS,
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
    localToken: TEST_LOCAL_TOKEN,
    eventsBus,
    guiChannel: new GuiChannel(options.guiChannel),
    player: new PlayerRuntime(),
    audioStreams: new AudioStreamRegistry(),
    cacheLeases: new SongLeaseRegistry(options.cacheLeases),
    downloads,
    bilibili,
    mediaTools,
    shutdownSignal: shutdownController.signal,
    ...(options.acceptance === undefined ? {} : { acceptance: options.acceptance }),
    fatals,
    shutdownController,
  });
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
