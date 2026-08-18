// Conflict records and their resolution (v0.2 T2, §4.6 / D4).
//
// A conflict here is narrow on purpose: a SONG whose remote put won while this
// device had unpushed edits of its own, and whose fields actually differ. Not
// playlists (a name is one field and the loser is rarely interesting), not
// memberships (existence has no middle ground), not lyrics (they are a
// document, and the last write is the whole point).
//
// The record is a receipt, not a merge: LWW already decided, the row already
// holds the remote value, and this table remembers what the user's own copy
// said so they can put it back. Which is why resolving takes the winner's LWW
// triple as `expected_current` — between seeing the conflict and answering it,
// a third device can write again, and restoring a local copy over THAT would
// undo a change the user never saw.

import type { LwwKey, SongSyncPayload } from '@lark/shared';
import {
  ConflictNotFoundError,
  ConflictPayloadUnavailableError,
  ConflictVersionMismatchError,
} from '../errors.js';
import { updateSongInTx } from '../library/songs.js';
import type { PortableDb } from '../portable/db.js';
import { uuid } from '../portable/runtime/random.js';
import type { SqliteLike } from '../portable/sqlite.js';
import { readSongLww } from './lww.js';

export interface ConflictRow {
  id: string;
  entity_type: string;
  entity_id: string;
  detected_at: number;
  resolved_at: number | null;
  resolution: string | null;
  losing_side: string | null;
  local_payload: string | null;
  remote_payload: string | null;
  local_updated_at_ms: number | null;
  remote_updated_at_ms: number | null;
  local_lww_counter: number | null;
  remote_lww_counter: number | null;
  local_device_id: string | null;
  remote_device_id: string | null;
  remote_seq: number | null;
}

export interface RecordConflictInput {
  entityType: 'song';
  entityId: string;
  remoteSeq: number;
  local: { payload: SongSyncPayload; key: LwwKey };
  remote: { payload: SongSyncPayload; key: LwwKey };
  nowMs?: number;
}

/** Write the receipt. Returns its id. */
export function recordConflict(sqlite: SqliteLike, input: RecordConflictInput): string {
  const id = uuid();
  sqlite
    .prepare(
      `INSERT INTO conflict_record
         (id, entity_type, entity_id, remote_seq, detected_at, losing_side,
          local_payload, remote_payload,
          local_updated_at_ms, remote_updated_at_ms,
          local_lww_counter, remote_lww_counter,
          local_device_id, remote_device_id)
       VALUES (?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.entityType,
      input.entityId,
      input.remoteSeq,
      input.nowMs ?? Date.now(),
      JSON.stringify(input.local.payload),
      JSON.stringify(input.remote.payload),
      input.local.key.updated_at_ms,
      input.remote.key.updated_at_ms,
      input.local.key.lww_counter,
      input.remote.key.lww_counter,
      input.local.key.device_id,
      input.remote.key.device_id,
    );
  return id;
}

/** Unresolved receipts, newest first. */
export function listConflicts(sqlite: SqliteLike, limit = 100): ConflictRow[] {
  return sqlite
    .prepare(
      `SELECT * FROM conflict_record WHERE resolved_at IS NULL
       ORDER BY detected_at DESC, id LIMIT ?`,
    )
    .all(limit) as ConflictRow[];
}

export function countUnresolvedConflicts(sqlite: SqliteLike): number {
  const row = sqlite
    .prepare('SELECT count(*) AS n FROM conflict_record WHERE resolved_at IS NULL')
    .get() as { n: number };
  return row.n;
}

export function getConflict(sqlite: SqliteLike, id: string): ConflictRow {
  const row = sqlite.prepare('SELECT * FROM conflict_record WHERE id = ?').get(id) as
    | ConflictRow
    | undefined;
  // Its own code, not the library's NOT_FOUND: a caller answering a conflict
  // needs to tell "that conflict is gone" (someone else resolved it, or
  // retention swept it) from "that song is gone", and the two lead to different
  // next moves.
  if (row === undefined) throw new ConflictNotFoundError(id);
  return row;
}

/** The LWW triple this device believes the row currently holds. */
export function conflictWinnerKey(row: ConflictRow): LwwKey {
  return {
    updated_at_ms: row.remote_updated_at_ms ?? 0,
    lww_counter: row.remote_lww_counter ?? 0,
    device_id: row.remote_device_id,
  };
}

/** Mark a receipt answered without touching the row (`strategy: 'remote'`). */
export function markConflictResolved(
  sqlite: SqliteLike,
  id: string,
  resolution: 'local' | 'remote',
  nowMs: number = Date.now(),
): void {
  sqlite
    .prepare('UPDATE conflict_record SET resolved_at = ?, resolution = ? WHERE id = ?')
    .run(nowMs, resolution, id);
}

export interface ResolveConflictInput {
  strategy: 'local' | 'remote';
  /** The winner's triple as the conflict recorded it — the CAS token. */
  expected_current: LwwKey;
}

/**
 * Answer a conflict.
 *
 * `remote` just files the receipt: the row already holds the remote value.
 * `local` writes the recorded local copy back through the ordinary update
 * path, so it takes a fresh key and is published like any other edit.
 *
 * The CAS is the point. Between the conflict appearing and the user answering
 * it, a third device can write again — restoring the local copy over THAT
 * would silently undo a change nobody ever saw. So the row must still hold
 * exactly the version this conflict says won.
 */
/**
 * The local side of a conflict, or a refusal.
 *
 * `null` and `'{}'` are the same thing here: a record that kept no copy of
 * what this device had. Both are reachable — the column is nullable, and a
 * row written before the payload was recorded carries the empty object.
 */
function parsePayload(raw: string | null): SongSyncPayload {
  const parsed = raw === null ? null : (JSON.parse(raw) as unknown);
  if (parsed === null || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
    throw new ConflictPayloadUnavailableError();
  }
  return parsed as SongSyncPayload;
}

export function resolveConflict(
  store: PortableDb,
  conflictId: string,
  input: ResolveConflictInput,
  nowMs: number = Date.now(),
): void {
  const { sqlite } = store;
  sqlite
    .transaction(() => {
      const conflict = getConflict(sqlite, conflictId);
      if (conflict.resolved_at !== null) {
        throw new ConflictVersionMismatchError('this conflict has already been resolved');
      }

      const current = readSongLww(sqlite, conflict.entity_id);
      if (current === null) {
        throw new ConflictVersionMismatchError('the song is gone — nothing left to restore');
      }
      const expected = input.expected_current;
      if (
        current.ms !== expected.updated_at_ms ||
        current.counter !== expected.lww_counter ||
        current.deviceId !== (expected.device_id ?? '')
      ) {
        throw new ConflictVersionMismatchError(
          'the song changed again since this conflict was recorded — reload and decide once more',
        );
      }

      if (input.strategy === 'local') {
        // Refused HERE, not in a dialog (§7 F3): "keep mine" needs a `mine` to
        // keep, and without a readable payload the restore below writes seven
        // undefineds — every field falls back to what is already there, the
        // LWW stamp bumps, and the device publishes an update that changes
        // nothing while telling the user it put their version back. A GUI can
        // grey the button out; only this can stop every other client.
        const local = parsePayload(conflict.local_payload);
        // Through the ordinary write path: a restore is an edit, and it has to
        // be published like one.
        updateSongInTx(store, conflict.entity_id, {
          name: local.name,
          artist: local.artist,
          source_url: local.source_url,
          source_provider: local.source_provider,
          source_key: local.source_key,
          lyrics_offset: local.lyrics_offset,
          duration: local.duration,
        });
      }
      markConflictResolved(sqlite, conflictId, input.strategy, nowMs);
    })
    .immediate();
}
