// A `CoordinatorContext` over a real database, for the coordinator's own
// suite (N1f).
//
// The coordinator moved into `portable/` and its tests came with it (subplan
// decision h). What they used to get from the daemon's `createTestContext` —
// a database, a filesystem, a credential store, an event sink, a logger — is
// assembled here instead, from the same real implementations: an actual
// SQLite database with the migration chain applied, the Node filesystem, the
// TOML credential store under whatever `LARK_NEST_DIR` says. The fakes are the
// two that have to be fake: the skybridge SDK (a real server is not a unit
// test) and the clock, where a test asks for one.
//
// The daemon's own assembly stays covered where it belongs — `routes/sync.ts`
// against the wire, and the two e2e suites against a real server.

import { type LarkEvent, SYNC_PULL_LIMIT } from '@lark/shared';
import { nodeCredentialStore } from '../config/skybridge.js';
import { type DatabaseHandles, createDatabase } from '../db/index.js';
import { nodeFileContext } from '../node-fs.js';
import type { SkybridgeApi } from '../portable/coordinator/client.js';
import type { CoordinatorContext } from '../portable/coordinator/context.js';
import { SyncRuntime } from '../portable/coordinator/runtime.js';
import type { StructuredLogger } from '../portable/logger.js';
import type { EventsBus } from '../portable/ports/events.js';
import { FileEffectRuntime, countQuarantined } from '../sync/file-ops-runtime.js';

export interface HarnessLogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  msg: string;
}

export interface RecordingCoordinatorLogger extends StructuredLogger {
  readonly records: HarnessLogRecord[];
}

/** Records instead of printing — core has no console-backed logger either. */
export function createRecordingCoordinatorLogger(): RecordingCoordinatorLogger {
  const records: HarnessLogRecord[] = [];
  const push =
    (level: HarnessLogRecord['level']) => (fields: Record<string, unknown>, msg: string) => {
      records.push({ level, fields, msg });
    };
  return {
    records,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}

export interface RecordingEventsBus extends EventsBus {
  readonly emitted: LarkEvent[];
}

export function createRecordingEventsBus(): RecordingEventsBus {
  const emitted: LarkEvent[] = [];
  return {
    emitted,
    emit(event) {
      emitted.push(event);
    },
  };
}

export interface CoordinatorHarnessOptions {
  /** The SDK stand-in. Required in practice — every path here talks to it. */
  api: SkybridgeApi;
  /** `:memory:` unless a test needs the database on disk. */
  dbPath?: string;
  now?: () => number;
  deviceName?: () => string;
  /** Off by default, as in the daemon's unit contexts: no timers here at all. */
  triggers?: boolean;
  pullLimit?: number;
  version?: string;
  intervalMin?: () => number;
}

export interface CoordinatorHarness extends CoordinatorContext {
  logger: RecordingCoordinatorLogger;
  events: RecordingEventsBus;
  /** The raw handle, for tests that assert against the rows directly. */
  sqlite: DatabaseHandles['sqlite'];
  close(): void;
}

/**
 * Build one.
 *
 * The credential store is the real desktop one, so a test MUST have stubbed
 * `LARK_NEST_DIR` to a temporary directory before calling this — exactly the
 * requirement the daemon harness had.
 */
export function createCoordinatorHarness(options: CoordinatorHarnessOptions): CoordinatorHarness {
  const { sqlite, portable } = createDatabase({ dbPath: options.dbPath ?? ':memory:' });
  const logger = createRecordingCoordinatorLogger();
  const events = createRecordingEventsBus();
  const fileOps = new FileEffectRuntime({ sqlite, logger });

  return {
    sync: new SyncRuntime({ triggers: options.triggers ?? false }),
    db: portable,
    files: nodeFileContext(),
    logger,
    credentials: nodeCredentialStore(),
    events,
    now: options.now ?? Date.now,
    deviceName: options.deviceName ?? (() => 'harness-device'),
    api: options.api,
    fileOps,
    countQuarantined,
    intervalMin: options.intervalMin ?? (() => 5),
    pullLimit: options.pullLimit ?? SYNC_PULL_LIMIT,
    version: options.version ?? '0.0.0-test',
    sqlite,
    close() {
      sqlite.close();
    },
  };
}
