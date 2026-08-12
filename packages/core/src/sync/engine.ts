// One sync round (v0.2 T2, §4.2).
//
// Pull first, then push. The order matters: applying what the workspace
// already knows before publishing local work is what lets the apply side make
// decisions with the newest information — the remote-delete file policy reads
// the outbox to decide whether lyrics are still unpublished, and that answer
// is only right if the pull ran first.
//
// core never imports a skybridge package. The client arrives as an interface
// (`SkybridgeClientLike`) so this module compiles — and tests — without a
// server, a token, or a network stack anywhere near it.

import {
  SYNC_PULL_LIMIT,
  SYNC_PUSH_BATCH_MAX,
  SYNC_PUSH_BYTES_MAX,
  type SyncEntityType,
  type SyncOp,
} from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { type ApplyResult, type InboundChange, applyChangesInTx } from './apply.js';
import type { FileEffectRuntime } from './file-ops.js';
import { setServerTimeOffset } from './hlc.js';

// ─── The client, as core needs it ──────────────────────

export interface SyncLocalChange {
  clientChangeId: string;
  entityType: string;
  entityId: string;
  op: string;
  payload: unknown;
  clientLocalSeq: number;
  clientCreatedAt: number;
  attachmentRefs: string[] | null;
}

export interface SyncServerChange {
  serverSeq: number;
  deviceId: string;
  clientChangeId: string;
  entityType: string;
  entityId: string;
  op: string;
  payload: unknown;
  clientLocalSeq: number;
  clientCreatedAt: number;
  serverReceivedAt: number;
  attachmentRefs: string[] | null;
}

export interface SyncPushAck {
  clientChangeId: string;
  serverSeq: number;
}

export interface SyncPushResult {
  accepted: SyncPushAck[];
  /** Changes the server already had. Also settled — just not by this attempt. */
  duplicates: SyncPushAck[];
  latestSeq: number;
  serverTime: number;
}

export interface SyncPullResult {
  changes: SyncServerChange[];
  hasMore: boolean;
  latestSeq: number;
  serverTime: number;
}

/** The subset of the skybridge client a sync round uses. */
export interface SkybridgeClientLike {
  pushChanges(workspaceId: string, changes: SyncLocalChange[]): Promise<SyncPushResult>;
  pullChanges(workspaceId: string, sinceSeq: number, limit?: number): Promise<SyncPullResult>;
}

// ─── Cursor ────────────────────────────────────────────

export interface SyncCursor {
  pulledSeq: number;
  pushedSeq: number;
}

/**
 * Read the cursor for this (server, workspace) pair.
 *
 * Keyed by ids and read with BOUND parameters — owl learned both the hard way.
 * A cursor keyed by URL restarts the pull from zero the first time a config
 * edit adds a trailing slash, and an interpolated key is a workspace id in a
 * SQL string.
 */
export function readCursor(
  sqlite: BetterSqlite3.Database,
  serverId: string,
  workspaceId: string,
): SyncCursor {
  const row = sqlite
    .prepare(
      'SELECT pulled_seq, pushed_seq FROM sync_cursor WHERE server_id = ? AND workspace_id = ?',
    )
    .get(serverId, workspaceId) as { pulled_seq: number; pushed_seq: number } | undefined;
  return { pulledSeq: row?.pulled_seq ?? 0, pushedSeq: row?.pushed_seq ?? 0 };
}

export function writeCursor(
  sqlite: BetterSqlite3.Database,
  serverId: string,
  workspaceId: string,
  cursor: Partial<SyncCursor>,
  nowMs: number = Date.now(),
): void {
  const current = readCursor(sqlite, serverId, workspaceId);
  sqlite
    .prepare(
      `INSERT INTO sync_cursor (server_id, workspace_id, pulled_seq, pushed_seq, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(server_id, workspace_id) DO UPDATE SET
         pulled_seq = excluded.pulled_seq,
         pushed_seq = excluded.pushed_seq,
         updated_at = excluded.updated_at`,
    )
    .run(
      serverId,
      workspaceId,
      cursor.pulledSeq ?? current.pulledSeq,
      cursor.pushedSeq ?? current.pushedSeq,
      nowMs,
    );
}

// ─── A round ───────────────────────────────────────────

/**
 * The one thing this module logs with.
 *
 * Declared structurally rather than as core's pino `Logger` so the daemon can
 * pass the four-method logger its context carries — a round is driven from a
 * context, and requiring the concrete pino type there would mean either a cast
 * or no log line at all.
 */
export interface SyncRoundLogger {
  warn(fields: Record<string, unknown>, msg: string): void;
}

export interface RunSyncOptions {
  sqlite: BetterSqlite3.Database;
  client: SkybridgeClientLike;
  serverId: string;
  workspaceId: string;
  /** Executes the file effects an applied batch queued. */
  fileOps?: FileEffectRuntime;
  logger?: SyncRoundLogger;
  signal?: AbortSignal;
  nowMs?: () => number;
  /** Pull page size. Lower only in tests — the server caps it at 1000. */
  pullLimit?: number;
}

export interface RunSyncResult {
  pulled: number;
  pushed: number;
  applied: number;
  skipped: number;
  deadLettered: number;
  conflicts: number;
  cursor: SyncCursor;
  /** True when the round stopped early because it was cancelled. */
  cancelled: boolean;
  songsTouched: boolean;
  playlistsTouched: boolean;
  lyricsTouched: string[];
}

/** Cooperative cancellation: a round in flight stops between batches, never mid-batch. */
class Cancelled extends Error {}

export async function runSync(options: RunSyncOptions): Promise<RunSyncResult> {
  const now = options.nowMs ?? Date.now;
  const result: RunSyncResult = {
    pulled: 0,
    pushed: 0,
    applied: 0,
    skipped: 0,
    deadLettered: 0,
    conflicts: 0,
    cursor: readCursor(options.sqlite, options.serverId, options.workspaceId),
    cancelled: false,
    songsTouched: false,
    playlistsTouched: false,
    lyricsTouched: [],
  };

  try {
    await pullPhase(options, result, now);
    await pushPhase(options, result, now);
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err;
    result.cancelled = true;
  }

  result.cursor = readCursor(options.sqlite, options.serverId, options.workspaceId);
  return result;
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Cancelled();
}

async function pullPhase(
  options: RunSyncOptions,
  result: RunSyncResult,
  now: () => number,
): Promise<void> {
  const limit = options.pullLimit ?? SYNC_PULL_LIMIT;

  for (;;) {
    checkCancelled(options.signal);
    const cursor = readCursor(options.sqlite, options.serverId, options.workspaceId);
    const page = await options.client.pullChanges(options.workspaceId, cursor.pulledSeq, limit);
    setServerTimeOffset(options.sqlite, page.serverTime - now());

    if (page.changes.length === 0) return;

    // The apply AND the cursor advance commit together. A crash between them
    // would either replay the batch (safe — every apply is idempotent) or skip
    // it (not safe), and only one transaction makes the first one the truth.
    const applied = options.sqlite
      .transaction(() => {
        const outcome = applyChangesInTx(options.sqlite, page.changes.map(toInboundChange), {
          nowMs: now,
        });
        const highest = page.changes.reduce((max, c) => Math.max(max, c.serverSeq), 0);
        writeCursor(
          options.sqlite,
          options.serverId,
          options.workspaceId,
          { pulledSeq: highest },
          now(),
        );
        return outcome;
      })
      .immediate();

    accumulate(result, applied);
    result.pulled += page.changes.length;

    // Drained AFTER the commit: the journal rows are the record, and executing
    // them inside the transaction would leave files changed but rows rolled
    // back if the commit failed.
    if (applied.fileOps > 0 && options.fileOps !== undefined) {
      await options.fileOps.drain();
    }

    if (!page.hasMore) return;
  }
}

function accumulate(result: RunSyncResult, applied: ApplyResult): void {
  result.applied += applied.applied;
  result.skipped += applied.skipped;
  result.deadLettered += applied.deadLettered;
  result.conflicts += applied.conflicts;
  result.songsTouched ||= applied.songsTouched;
  result.playlistsTouched ||= applied.playlistsTouched;
  result.lyricsTouched.push(...applied.lyricsTouched);
}

export function toInboundChange(change: SyncServerChange): InboundChange {
  return {
    server_seq: change.serverSeq,
    device_id: change.deviceId,
    client_change_id: change.clientChangeId,
    entity_type: change.entityType,
    entity_id: change.entityId,
    op: change.op,
    payload: change.payload,
    client_local_seq: change.clientLocalSeq,
    client_created_at: change.clientCreatedAt,
    server_received_at: change.serverReceivedAt,
  };
}

interface PendingRow {
  local_seq: number;
  entity_type: SyncEntityType;
  entity_id: string;
  op: SyncOp;
  payload: string;
  created_at: number;
  client_change_id: string;
}

async function pushPhase(
  options: RunSyncOptions,
  result: RunSyncResult,
  now: () => number,
): Promise<void> {
  for (;;) {
    checkCancelled(options.signal);
    const pending = options.sqlite
      .prepare(
        `SELECT local_seq, entity_type, entity_id, op, payload, created_at, client_change_id
         FROM sync_changes WHERE synced_at IS NULL ORDER BY local_seq
         LIMIT ?`,
      )
      .all(SYNC_PUSH_BATCH_MAX) as PendingRow[];
    if (pending.length === 0) return;

    const batch = boxBatch(pending);
    const response = await options.client.pushChanges(
      options.workspaceId,
      batch.map(toLocalChange),
    );
    setServerTimeOffset(options.sqlite, response.serverTime - now());

    // Duplicates count as settled: the server already has them, and leaving
    // them pending would push the same change on every round forever.
    const settled = [...response.accepted, ...response.duplicates];
    options.sqlite
      .transaction(() => {
        const mark = options.sqlite.prepare(
          'UPDATE sync_changes SET synced_at = ?, server_seq = ? WHERE client_change_id = ?',
        );
        for (const ack of settled) mark.run(now(), ack.serverSeq, ack.clientChangeId);
        writeCursor(
          options.sqlite,
          options.serverId,
          options.workspaceId,
          { pushedSeq: response.latestSeq },
          now(),
        );
      })
      .immediate();

    result.pushed += settled.length;

    // A server that acknowledged nothing would otherwise spin this loop.
    if (settled.length === 0) {
      options.logger?.warn(
        { batch: batch.length },
        'sync push acknowledged nothing — stopping the round',
      );
      return;
    }
    if (batch.length === pending.length && pending.length < SYNC_PUSH_BATCH_MAX) return;
  }
}

/**
 * Fill one request up to BOTH limits (§4.2).
 *
 * Count and bytes are independent server limits, and either can bind first: a
 * thousand tiny renames hit the count, a handful of lyrics documents hit the
 * body size. A batch is never empty — a single change over the byte budget
 * cannot exist, because the emit guard refused it long before it got here.
 */
function boxBatch(pending: readonly PendingRow[]): PendingRow[] {
  const batch: PendingRow[] = [];
  let bytes = 0;
  for (const row of pending) {
    const size = Buffer.byteLength(row.payload, 'utf8') + 256; // + envelope headroom
    if (
      batch.length > 0 &&
      (bytes + size > SYNC_PUSH_BYTES_MAX || batch.length >= SYNC_PUSH_BATCH_MAX)
    ) {
      break;
    }
    batch.push(row);
    bytes += size;
  }
  return batch;
}

function toLocalChange(row: PendingRow): SyncLocalChange {
  return {
    clientChangeId: row.client_change_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    op: row.op,
    payload: JSON.parse(row.payload),
    clientLocalSeq: row.local_seq,
    clientCreatedAt: row.created_at,
    attachmentRefs: null,
  };
}
