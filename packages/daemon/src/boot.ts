// Daemon boot orchestration + lifecycle state machine (M2-1).
//
// One sequence serves both entry points — `lark-daemon daemon` today, the
// GUI-spawned daemon in M4 — so there is exactly one place where the PID lock,
// the database, the token and the socket are acquired, and exactly one place
// where they are released.
//
// The state machine exists because signals do not wait for convenient moments.
// A SIGTERM landing while `listen()` is still pending used to have two exits
// racing each other: the signal handler tearing down (exit 0) and the boot
// continuation happily publishing a token for a server nobody will use.
// Instead:
//
//   - `beginStop(reason)` is FIRST-WINS: the first reason decides the exit
//     code (`signal` → 0, `boot-failure` / `fatal` → 1) and later reasons
//     never overwrite it;
//   - while boot still drives the sequence, a signal only RECORDS the stop —
//     boot's own checkpoints observe it and finish the stop, so there is one
//     exit path, not two;
//   - `teardown()` is the single idempotent release primitive, in reverse
//     acquisition order, and releases the PID lock LAST (releasing it first,
//     as owl does, lets a successor daemon open the database this one still
//     holds).

import { mkdirSync } from 'node:fs';
import {
  DestructiveForwardMigrationError,
  DownloadEngine,
  ForwardMigrationError,
  GoMigrationRequiredError,
  IncompatibleDbError,
  MigrationBusyError,
  MigrationResidueError,
  SchemaMismatchError,
  createBilibiliClient,
  createDatabase,
  createLogger,
  loadConfig,
  paths,
  recoverSongsStore,
  resolveFfmpegBinaries,
  resolveLlmConfig,
} from '@lark/core';
import { DEFAULT_DAEMON_PORT, type LarkConfig } from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import { type AcceptanceOptions, type AppContext, CONTEXT_DEFAULTS } from './context.js';
import { EventsBus } from './events/bus.js';
import { GuiChannel } from './events/gui-channel.js';
import { generateLocalToken, publishLocalToken } from './local-token.js';
import {
  DaemonAlreadyRunningError,
  PidFileCorruptError,
  acquireDaemonLock,
  removePid,
} from './pid.js';
import { PlayerRuntime } from './player-runtime.js';
import { buildServer } from './server.js';

export interface BootOptions {
  /** Resolve the daemon config. Defaults to core's `loadConfig()`. */
  resolveConfig?: () => LarkConfig;
  /**
   * TEST SEAM. The real CLI never passes this: 47100 is a constant baked into
   * the renderer CSP, so there is no port setting to get wrong. Tests pass 0
   * to get an ephemeral port and read the real one off the listen line.
   */
  port?: number;
  /** TEST SEAM: pause before `listen()` so a signal can be delivered mid-boot. */
  stallBeforeListenMs?: number;
  /** TEST SEAM: fire `requestFatal` this long after a successful boot. */
  fatalAfterMs?: number;
  /**
   * ACCEPTANCE SEAMS (M4 T6): `/audio` write pacing and the debug stream
   * counter. Only `testing/boot-child.ts` ever sets these.
   */
  acceptance?: AcceptanceOptions;
}

type LifecycleState = 'booting' | 'running' | 'stopping' | 'stopped';
type StopReason = 'signal' | 'boot-failure' | 'fatal';

function resolvePort(port: number | undefined): number {
  if (port === undefined) return DEFAULT_DAEMON_PORT;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid daemon port: ${port}`);
  }
  return port;
}

/**
 * Terminal user-facing text for a boot failure. `createDatabase`'s error
 * classes are mapped explicitly (no "there are N of them" counting — that is
 * how `DestructiveForwardMigrationError` got missed once) with a catch-all
 * behind them, so a class added later still produces a sensible message.
 */
function describeBootFailure(err: unknown): string {
  if (err instanceof DaemonAlreadyRunningError) return err.message;
  if (err instanceof PidFileCorruptError) return err.message;
  if (err instanceof GoMigrationRequiredError) {
    return `${err.message}\n运行 \`just migrate-go\` 完成迁移后再启动 daemon。`;
  }
  if (err instanceof MigrationBusyError) {
    return `数据库迁移正在进行或被其他进程占用（${err.reason}），请稍后再试。`;
  }
  if (
    err instanceof IncompatibleDbError ||
    err instanceof SchemaMismatchError ||
    err instanceof MigrationResidueError ||
    err instanceof ForwardMigrationError ||
    err instanceof DestructiveForwardMigrationError
  ) {
    return `数据库无法打开（${err.name}）：${err.message}`;
  }
  return `daemon 启动失败：${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
}

/**
 * Boot the daemon and hand the process over to it.
 *
 * Process-owning entry point: it installs signal handlers and calls
 * `process.exit`. The returned promise resolving does NOT mean the daemon
 * stopped — after a successful listen the process stays alive on the server
 * socket. Callers must not use it for control flow.
 */
export async function boot(options: BootOptions = {}): Promise<void> {
  const port = resolvePort(options.port);

  mkdirSync(paths.larkDir(), { recursive: true });
  const config = (options.resolveConfig ?? loadConfig)();
  const logFilePath = paths.larkLogPath();
  // Keep the concrete pino type: `createDatabase` wants pino's Logger, while
  // AppContext only needs the four-method subset this satisfies structurally.
  const logger = createLogger({ filePath: logFilePath, config: config.log, name: 'daemon' });

  let state: LifecycleState = 'booting';
  let stopReason: StopReason | null = null;
  /** True while `boot` itself drives the sequence (see the header note). */
  let bootDriving = true;
  let lockHeld = false;
  let ctx: AppContext | null = null;
  let server: FastifyInstance | null = null;
  let teardownPromise: Promise<void> | null = null;
  const shutdownController = new AbortController();

  const beginStop = (reason: StopReason): boolean => {
    if (stopReason !== null) return false; // first-wins
    logger.info({ from: state, reason }, 'daemon stopping');
    stopReason = reason;
    state = 'stopping';
    return true;
  };

  /**
   * Release everything acquired so far, in reverse order. Idempotent.
   *
   * The order around `server.close()` is the part that matters (M3-13). It
   * waits for in-flight REQUESTS, so anything a request might be blocked on
   * has to be released first: a parked player command, and — since M3 — any
   * handler-side network call, which is what aborting `shutdownController`
   * unblocks. `downloads.close()` comes AFTER, because the worker is not a
   * request: closing it first would make the server wait on a request whose
   * engine had already gone away.
   */
  const teardown = (): Promise<void> => {
    teardownPromise ??= (async () => {
      // In-flight player commands first: they are HTTP requests parked on a
      // GUI ack, and `server.close()` waits for in-flight requests to finish.
      ctx?.player.failAll({ kind: 'shutting-down' });
      shutdownController.abort(new Error('daemon shutting down'));
      if (server) await server.close(); // preClose ends the SSE streams
      await ctx?.downloads.close(); // worker exit + ffmpeg children reaped
      ctx?.guiChannel.close(); // registry timers + connection refs
      ctx?.eventsBus.close();
      ctx?.sqlite.close();
      if (lockHeld) removePid(); // last: the lock outlives everything it guards
      state = 'stopped';
    })();
    return teardownPromise;
  };

  const finishStop = async (): Promise<void> => {
    await teardown();
    process.exit(stopReason === 'signal' ? 0 : 1);
  };

  /**
   * Record a stop request. While boot is still driving, this only sets the
   * reason — boot's next checkpoint performs the teardown, so the two never
   * race for the exit.
   */
  const requestStop = (reason: StopReason): void => {
    if (!beginStop(reason)) return;
    if (bootDriving) return;
    void finishStop();
  };

  /** Abort a boot that cannot continue: explain, tear down, exit 1. */
  const abortBoot = async (err: unknown): Promise<void> => {
    beginStop('boot-failure'); // may lose to an in-flight signal — that is fine
    logger.error({ err }, 'daemon failed to start');
    console.error(describeBootFailure(err)); // log-hygiene: console-ok
    await finishStop();
  };

  try {
    acquireDaemonLock();
    lockHeld = true;
  } catch (err) {
    await abortBoot(err);
    return;
  }

  // Installed the moment the lock exists, so a signal at ANY later point goes
  // through the state machine instead of killing the process with the lock,
  // the database and possibly a half-written token file still held.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info({ signal }, 'stop requested');
      requestStop('signal');
    });
  }

  try {
    const { db, sqlite } = createDatabase({ dbPath: paths.dbPath(), logger });

    // BEFORE the engine exists, so no task can be racing the reconciliation
    // (M3-7). Anything it finds is residue from a previous process's death.
    const recovery = recoverSongsStore(db, sqlite);
    logger.info({ ...recovery, notes: undefined }, 'songs store recovered');
    for (const note of recovery.notes) logger.warn({ note }, 'recovery note');

    const binaries = resolveFfmpegBinaries();
    logger.info(
      {
        ffmpeg: binaries.ffmpeg.path,
        ffmpeg_source: binaries.ffmpeg.source,
        ffprobe: binaries.ffprobe.path,
        ffprobe_source: binaries.ffprobe.source,
      },
      'media tools resolved',
    );

    // Built before the context so the engine's callbacks can close over it:
    // the async side of the download pipeline has no route to emit from, so
    // engine lifecycle callbacks ARE the event source (M3-6).
    const eventsBus = new EventsBus();
    const bilibili = createBilibiliClient();
    const downloads = new DownloadEngine({
      db,
      sqlite,
      bilibili,
      // Read fresh, so a PATCH /config is picked up by the next task — and
      // snapshotted per task, so it cannot change mid-download.
      getLlmConfig: () => resolveLlmConfig(ctx?.config ?? config),
      logger,
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
          // What changed depends on the kind: a lyrics task never touches the
          // library, and a download only touches playlists if it joined one.
          if (task.kind === 'lyrics') {
            if (task.result !== null) {
              eventsBus.emit({ type: 'lyrics:changed', song_id: task.result.song_id });
            }
            return;
          }
          eventsBus.emit({ type: 'songs:changed' });
          if (task.playlist_ids.length > 0) eventsBus.emit({ type: 'playlists:changed' });
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
    });

    ctx = {
      ...CONTEXT_DEFAULTS,
      config,
      port,
      configPath: paths.configPath(),
      requestFatal: (err: unknown) => {
        // Idempotent AND non-waiting (M2-1 ①): the caller is usually a route
        // that still has to send its 500. Teardown closes the server, which
        // waits for that request — so it must not start until the caller has
        // returned. Hence `setImmediate`, and never `await`.
        if (!beginStop('fatal')) return;
        logger.error({ err }, 'fatal daemon error — shutting down');
        setImmediate(() => void finishStop());
      },
      logger,
      db,
      sqlite,
      localToken: generateLocalToken(), // memory only until listen() succeeds
      eventsBus,
      guiChannel: new GuiChannel(),
      player: new PlayerRuntime(),
      downloads,
      bilibili,
      shutdownSignal: shutdownController.signal,
      ...(options.acceptance === undefined ? {} : { acceptance: options.acceptance }),
    };
    server = buildServer(ctx);
  } catch (err) {
    await abortBoot(err);
    return;
  }

  if (options.stallBeforeListenMs !== undefined && options.stallBeforeListenMs > 0) {
    await new Promise((r) => setTimeout(r, options.stallBeforeListenMs));
  }
  if (stopReason !== null) return finishStop();

  try {
    await server.listen({ host: ctx.host, port });
  } catch (err) {
    await abortBoot(err);
    return;
  }

  // A signal may have landed while `listen()` was pending. Publishing a token
  // for a server we are about to close would rotate the on-disk token for
  // nothing — and leave every live client unable to authenticate.
  if (stopReason !== null) return finishStop();

  const address = server.server.address();
  if (address !== null && typeof address === 'object') ctx.port = address.port;

  try {
    publishLocalToken(ctx.localToken);
  } catch (err) {
    await abortBoot(err);
    return;
  }

  state = 'running';
  bootDriving = false;
  logger.info({ host: ctx.host, port: ctx.port, pid: process.pid }, 'daemon listening');
  // The one terminal line a foreground daemon owes its operator — pino writes
  // to a file, and a mute foreground process looks hung. Tests parse the port
  // out of this line.
  const listenLine = `lark daemon listening on http://${ctx.host}:${ctx.port} (logs: ${logFilePath})`;
  console.log(listenLine); // log-hygiene: console-ok

  if (options.fatalAfterMs !== undefined && options.fatalAfterMs >= 0) {
    setTimeout(() => ctx?.requestFatal(new Error('injected test fatal')), options.fatalAfterMs);
  }

  // A signal delivered during the final microtasks above would have been
  // recorded while `bootDriving` was still true; honour it now.
  if (stopReason !== null) return finishStop();
}
