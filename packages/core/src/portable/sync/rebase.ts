// Registration-time key rebase (v0.2 T1d, §3.3 / R32-②).
//
// v0.1 stamped LWW keys with the bare local clock. A machine whose clock was
// an hour — or a year — fast carries rows stamped in the future, and the
// moment it joins a workspace those rows beat every honest edit any device
// makes until real time catches up. Nothing about the running HLC fixes that:
// it only keeps this device monotonic, and it will happily keep issuing keys
// above the bad ones.
//
// So the very first binding rewrites history that has not left the machine
// yet. It runs INSIDE the registration transaction, after the backfill, which
// is what makes it safe: the backfill guarantees every surviving entity has at
// least one pending LWW op, so rewriting the op AND the row together keeps the
// two in agreement and the new key is what actually gets pushed.
//
// What is deliberately not rebased:
//
//   Rows with no pending op. Their key already reached the server; rewriting
//   it locally would only make this device disagree with the workspace.
//   Metadata ops (`set_rank`, `reorder`, `set_lyrics`, `clear_lyrics`). They
//   carry no key at all — server order decides them.

import type { SqliteLike } from '../sqlite.js';
import { type LwwStamp, seedHlc } from './hlc.js';

/** How far ahead of the server a key may be before it counts as broken. */
export const REBASE_TOLERANCE_MS = 5 * 60 * 1000;

export interface RebaseResult {
  /** Entities whose keys were rewritten. */
  entities: number;
  /** Pending LWW ops that took a new key. */
  ops: number;
  /** Where the local clock was left. */
  seed: LwwStamp;
}

interface PendingOp {
  local_seq: number;
  entity_type: string;
  entity_id: string;
  op: string;
  updated_at_ms: number;
}

const TABLE_BY_ENTITY: Record<string, string> = {
  song: 'songs',
  playlist: 'playlists',
};

/**
 * Rewrite every future-dated key this device has not pushed yet.
 *
 * `serverNowMs` is the server's clock at registration; keys more than
 * REBASE_TOLERANCE_MS beyond it are treated as clock damage rather than as
 * genuinely recent edits.
 */
export function rebaseLocalKeys(
  sqlite: SqliteLike,
  serverNowMs: number,
  toleranceMs: number = REBASE_TOLERANCE_MS,
): RebaseResult {
  const horizon = serverNowMs + toleranceMs;

  // Only LWW ops have a key to rebase. The json_type gate is the actual
  // test — an op is rebasable because its payload carries `updated_at_ms`,
  // not because of its name. It accepts `real` as well as `integer`: SQLite's
  // json_set writes a bound number as `1800000000000.0` unless it is CAST, so
  // an integer-only gate would make a rebased payload invisible to the next
  // rebase and to the seed query below.
  const pending = sqlite
    .prepare(
      `SELECT local_seq, entity_type, entity_id, op,
              json_extract(payload, '$.updated_at_ms') AS updated_at_ms
       FROM sync_changes
       WHERE synced_at IS NULL
         AND json_type(payload, '$.updated_at_ms') IN ('integer', 'real')
       ORDER BY local_seq`,
    )
    .all() as PendingOp[];

  const byEntity = new Map<string, PendingOp[]>();
  for (const op of pending) {
    const key = `${op.entity_type}\u0000${op.entity_id}`;
    const list = byEntity.get(key);
    if (list === undefined) byEntity.set(key, [op]);
    else list.push(op);
  }

  const result: RebaseResult = { entities: 0, ops: 0, seed: { updated_at: 0, lww_counter: 0 } };

  for (const [key, ops] of byEntity) {
    const [entityType, entityId] = key.split('\u0000');
    const rowMs = readRowMs(sqlite, entityType, entityId);
    const tombMs = readTombstoneMs(sqlite, entityType, entityId);
    const maxMs = Math.max(
      rowMs ?? Number.NEGATIVE_INFINITY,
      tombMs ?? Number.NEGATIVE_INFINITY,
      ...ops.map((o) => o.updated_at_ms),
    );
    if (maxMs <= horizon) continue;

    // One entity, one collapsed timeline: its pending ops keep their relative
    // order and take (server_now, 0..k), so a later edit still beats an
    // earlier one after the rewrite.
    ops.forEach((op, index) => {
      sqlite
        .prepare(
          // CAST keeps the rewritten key an integer in the stored JSON. It
          // parses the same either way, but a payload full of `…000.0` reads
          // as damage the first time somebody looks at the outbox.
          `UPDATE sync_changes
           SET payload = json_set(payload,
                 '$.updated_at_ms', CAST(? AS INTEGER),
                 '$.lww_counter', CAST(? AS INTEGER))
           WHERE local_seq = ?`,
        )
        .run(serverNowMs, index, op.local_seq);
      result.ops += 1;
    });

    const last = { ms: serverNowMs, counter: ops.length - 1 };
    writeRowKey(sqlite, entityType, entityId, last);
    writeTombstoneKey(sqlite, entityType, entityId, last);
    result.entities += 1;
  }

  result.seed = seedFromLocalState(sqlite);
  seedHlc(sqlite, result.seed);
  return result;
}

function readRowMs(sqlite: SqliteLike, entityType: string, entityId: string): number | null {
  if (entityType === 'playlist_song') {
    const [playlistId, songId] = entityId.split(':');
    const row = sqlite
      .prepare('SELECT updated_at FROM playlist_songs WHERE playlist_id = ? AND song_id = ?')
      .get(playlistId, songId) as { updated_at: number } | undefined;
    return row?.updated_at ?? null;
  }
  const table = TABLE_BY_ENTITY[entityType];
  if (table === undefined) return null;
  const row = sqlite.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`).get(entityId) as
    | { updated_at: number }
    | undefined;
  return row?.updated_at ?? null;
}

function readTombstoneMs(sqlite: SqliteLike, entityType: string, entityId: string): number | null {
  const row = sqlite
    .prepare('SELECT updated_at FROM sync_tombstones WHERE entity_type = ? AND entity_id = ?')
    .get(entityType, entityId) as { updated_at: number } | undefined;
  return row?.updated_at ?? null;
}

function writeRowKey(
  sqlite: SqliteLike,
  entityType: string,
  entityId: string,
  key: { ms: number; counter: number },
): void {
  if (entityType === 'playlist_song') {
    const [playlistId, songId] = entityId.split(':');
    sqlite
      .prepare(
        `UPDATE playlist_songs SET updated_at = ?, lww_counter = ?
         WHERE playlist_id = ? AND song_id = ?`,
      )
      .run(key.ms, key.counter, playlistId, songId);
    return;
  }
  const table = TABLE_BY_ENTITY[entityType];
  if (table === undefined) return;
  sqlite
    .prepare(`UPDATE ${table} SET updated_at = ?, lww_counter = ? WHERE id = ?`)
    .run(key.ms, key.counter, entityId);
}

function writeTombstoneKey(
  sqlite: SqliteLike,
  entityType: string,
  entityId: string,
  key: { ms: number; counter: number },
): void {
  // A tombstone travels with the pending delete that produced it, so the two
  // must not drift apart during a rewrite.
  sqlite
    .prepare(
      `UPDATE sync_tombstones SET updated_at = ?, lww_counter = ?
       WHERE entity_type = ? AND entity_id = ?`,
    )
    .run(key.ms, key.counter, entityType, entityId);
}

/**
 * The highest key anywhere in the local state after the rewrite: rows,
 * tombstones and pending payloads alike.
 *
 * The clock is seeded from ALL of it, not just from what was rebased. An
 * entity left alone because it sits inside the tolerance still holds the
 * highest key this device has issued, and the next local edit has to outrank
 * it.
 */
function seedFromLocalState(sqlite: SqliteLike): LwwStamp {
  const queries = [
    'SELECT updated_at AS ms, lww_counter AS counter FROM songs ORDER BY ms DESC, counter DESC LIMIT 1',
    'SELECT updated_at AS ms, lww_counter AS counter FROM playlists ORDER BY ms DESC, counter DESC LIMIT 1',
    'SELECT updated_at AS ms, lww_counter AS counter FROM playlist_songs ORDER BY ms DESC, counter DESC LIMIT 1',
    'SELECT updated_at AS ms, lww_counter AS counter FROM sync_tombstones ORDER BY ms DESC, counter DESC LIMIT 1',
    `SELECT json_extract(payload, '$.updated_at_ms') AS ms,
            json_extract(payload, '$.lww_counter') AS counter
     FROM sync_changes
     WHERE json_type(payload, '$.updated_at_ms') IN ('integer', 'real')
     ORDER BY ms DESC, counter DESC LIMIT 1`,
  ];

  let seed: LwwStamp = { updated_at: 0, lww_counter: 0 };
  for (const sql of queries) {
    const row = sqlite.prepare(sql).get() as { ms: number; counter: number } | undefined;
    if (row === undefined || row.ms === null) continue;
    const counter = row.counter ?? 0;
    if (row.ms > seed.updated_at || (row.ms === seed.updated_at && counter > seed.lww_counter)) {
      seed = { updated_at: row.ms, lww_counter: counter };
    }
  }
  return seed;
}
