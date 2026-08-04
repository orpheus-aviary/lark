// Test harness: a real AppContext over an in-memory database, and a server
// whose `inject` carries the Bearer token by default.
//
// `buildTestServer(ctx)` is a drop-in for `buildServer(ctx)` — same Fastify
// app, so `app.inject({...})` call sites are unchanged — except that every
// injected request gets `Authorization: Bearer <ctx.localToken>`. Boundary
// tests that must send NO or a WRONG token use `app.injectRaw(...)`, the
// unpatched original; caller-supplied headers always win, so a single call can
// override the bearer inline.

import { DEFAULT_CONFIG, createDatabase } from '@lark/core';
import type { LarkConfig } from '@lark/shared';
import { type AppContext, CONTEXT_DEFAULTS, type Logger } from '../context.js';
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
  configPath?: string;
  saveConfigImpl?: (config: LarkConfig, path?: string) => void;
  guiChannel?: GuiChannelOptions;
  ackTimeoutMs?: number;
  /** File-backed db when a test needs one; defaults to `:memory:`. */
  dbPath?: string;
}

export interface TestContext extends AppContext {
  logger: RecordingLogger;
  /** Everything `requestFatal` was called with — no process ever exits here. */
  readonly fatals: unknown[];
}

/** A complete context over a fresh in-memory database. */
export function createTestContext(options: TestContextOptions = {}): TestContext {
  const { db, sqlite } = createDatabase({ dbPath: options.dbPath ?? ':memory:' });
  const fatals: unknown[] = [];
  const ctx: TestContext = {
    ...CONTEXT_DEFAULTS,
    config: options.config ?? structuredClone(DEFAULT_CONFIG),
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
    eventsBus: new EventsBus(),
    guiChannel: new GuiChannel(options.guiChannel),
    player: new PlayerRuntime(),
    fatals,
  };
  return ctx;
}

/** Release everything a test context owns (mirrors boot's teardown order). */
export function closeTestContext(ctx: TestContext): void {
  ctx.player.failAll({ kind: 'shutting-down' });
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
