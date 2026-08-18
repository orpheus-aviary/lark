// The outbox: local writes append here, the engine drains it (v0.2 T1).
//
// Every emit MUST run inside the same sqlite transaction as the business write
// it describes. That is the whole crash story: a committed row with no change
// row would be a local edit no peer ever hears about, and a committed change
// row with no local row would push a lie.
//
// Two things live here besides the append itself, because both are about what
// leaves this machine: the byte guard (§3.9) and the dead-letter archive
// (§3.8). Neither belongs to a single entity, and neither is worth a module.

import {
  SYNC_CHANGE_BYTES_MAX,
  type SyncChangePayload,
  type SyncEntityType,
  type SyncOp,
} from '@lark/shared';
import { SyncChangeTooLargeError } from '../errors.js';
import { uuid } from '../portable/runtime/random.js';
import { utf8ByteLength } from '../portable/runtime/text.js';
import type { SqliteLike } from '../portable/sqlite.js';

export interface EmitChangeArgs {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncOp;
  /** Serialized to JSON. Which shape is legal is fixed by (entityType, op). */
  payload: SyncChangePayload;
  /** Override the row's `created_at` (unix ms). Tests pass a fixed value. */
  nowMs?: number;
}

/**
 * Append one outbox row and return its `client_change_id`.
 *
 * The cid is a UUIDv4 minted here (the server's dedupe key, and required to be
 * a uuid by the skybridge schema), and `sync_changes.device_id` is this
 * install's LOCAL `device_uuid` — forensics only. The skybridge registration
 * id lives on the entity row instead, and the two never mix (R18).
 *
 * Throws {@link SyncChangeTooLargeError} before writing anything if the change
 * would exceed the wire budget.
 */
export function emitSyncChange(sqlite: SqliteLike, args: EmitChangeArgs): string {
  const deviceUuid = readLocalDeviceUuid(sqlite);
  const clientChangeId = uuid();
  const createdAt = args.nowMs ?? Date.now();
  const payloadJson = JSON.stringify(args.payload);

  assertChangeFits(args, clientChangeId, createdAt);

  sqlite
    .prepare(
      `INSERT INTO sync_changes
         (device_id, entity_type, entity_id, op, payload, created_at, client_change_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      deviceUuid,
      args.entityType,
      args.entityId,
      args.op,
      payloadJson,
      createdAt,
      clientChangeId,
    );
  return clientChangeId;
}

/**
 * Measure the change as the server will see it, not just its payload.
 *
 * `client_local_seq` is only known after the insert, so the measurement uses
 * the largest value it could ever hold — the estimate is an upper bound, which
 * is the direction that keeps a change that passed here from being refused
 * later.
 */
function assertChangeFits(args: EmitChangeArgs, clientChangeId: string, createdAt: number): void {
  const wire = {
    client_change_id: clientChangeId,
    entity_type: args.entityType,
    entity_id: args.entityId,
    op: args.op,
    payload: args.payload,
    client_local_seq: Number.MAX_SAFE_INTEGER,
    client_created_at: createdAt,
  };
  const bytes = utf8ByteLength(JSON.stringify(wire));
  if (bytes > SYNC_CHANGE_BYTES_MAX) {
    throw new SyncChangeTooLargeError(
      args.entityType,
      args.entityId,
      args.op,
      bytes,
      SYNC_CHANGE_BYTES_MAX,
    );
  }
}

/** This install's local identity. Present since M1 — created at db open. */
export function readLocalDeviceUuid(sqlite: SqliteLike): string {
  const row = sqlite.prepare("SELECT value FROM local_metadata WHERE key='device_uuid'").get() as
    | { value: string }
    | undefined;
  if (!row?.value) {
    // createDatabase guarantees this row; a database without it was not opened
    // through the supported path, and guessing an identity here would attach
    // this library's changes to a device that does not exist.
    throw new Error(
      'local_metadata.device_uuid is missing — open the database with createDatabase',
    );
  }
  return row.value;
}

export interface DeadLetterInput {
  direction: 'in' | 'out';
  /** Short machine-ish reason, e.g. `invalid_payload`, `unknown_op`. */
  reason: string;
  serverSeq?: number | null;
  clientChangeId?: string | null;
  deviceId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  op?: string | null;
  /**
   * Already-serialized JSON. Inbound: the COMPLETE wire envelope, so a bug
   * found next month can be diagnosed and replayed from the archive. Outbound:
   * a summary — what failed was too big by definition.
   */
  payload?: string | null;
  nowMs?: number;
}

/** Archive a change that could not be applied or emitted. Returns its row id. */
export function recordDeadLetter(sqlite: SqliteLike, input: DeadLetterInput): number {
  const info = sqlite
    .prepare(
      `INSERT INTO sync_dead_letters
         (direction, server_seq, client_change_id, device_id,
          entity_type, entity_id, op, payload, reason, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.direction,
      input.serverSeq ?? null,
      input.clientChangeId ?? null,
      input.deviceId ?? null,
      input.entityType ?? null,
      input.entityId ?? null,
      input.op ?? null,
      input.payload ?? null,
      input.reason,
      input.nowMs ?? Date.now(),
    );
  return Number(info.lastInsertRowid);
}

export interface DeadLetterCounts {
  in: number;
  out: number;
}

/** `{in, out}` counts for `GET /sync/status`. */
export function countDeadLetters(sqlite: SqliteLike): DeadLetterCounts {
  const rows = sqlite
    .prepare('SELECT direction, count(*) AS n FROM sync_dead_letters GROUP BY direction')
    .all() as { direction: string; n: number }[];
  const counts: DeadLetterCounts = { in: 0, out: 0 };
  for (const row of rows) {
    if (row.direction === 'in') counts.in = row.n;
    if (row.direction === 'out') counts.out = row.n;
  }
  return counts;
}

/** Outbox rows this device has not pushed yet. */
export function countPendingChanges(sqlite: SqliteLike): number {
  const row = sqlite
    .prepare('SELECT count(*) AS n FROM sync_changes WHERE synced_at IS NULL')
    .get() as { n: number };
  return row.n;
}
