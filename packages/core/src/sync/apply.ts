// Applying what the workspace says (v0.2 T2, §3.2 / §3.5 / §3.8).
//
// Every inbound change runs the same four gates, IN THIS ORDER:
//
//   1. the parent gate — an op about a song or playlist this device has
//      deleted, or has never seen, has nothing to apply to. It sits above
//      everything else, so even this device's own echo is dropped when the
//      parent went away in the meantime.
//   2. the metadata-op branch — `set_lyrics`, `clear_lyrics`, `reorder` and
//      `set_rank` carry no key, are ordered by server_seq alone, and are
//      REPLAYED even when they are our own echo. That replay is what makes
//      them converge.
//   3. self-replay — for LWW puts and tombstones only: our own accepted change
//      coming back must not be re-applied, or an update we have since
//      superseded locally would be restored.
//   4. LWW — compare against `max(row, tombstone)`, never against the row
//      alone. Asking those separately is how an update-on-missing quietly
//      resurrects something the workspace deleted.
//
// Everything here writes raw SQL against the caller's transaction, and every
// FILE consequence becomes a journal row in that same transaction rather than
// a filesystem call (§3.6): the cursor moves with the batch, and a crash
// between the commit and the file has one recovery direction.

import type {
  PlaylistSongSyncPayload,
  PlaylistSyncPayload,
  ReorderSyncPayload,
  SetLyricsSyncPayload,
  SetRankSyncPayload,
  SongSyncPayload,
  TombstoneSyncPayload,
} from '@lark/shared';
import { RANK_STEP } from '../library/rank.js';
import type { SqliteLike } from '../portable/sqlite.js';
import { recordDeadLetter } from './changes.js';
import { recordConflict } from './conflicts.js';
import {
  type AudioOrigin,
  enqueueDeleteLyrics,
  enqueueRemoteDelete,
  enqueueWriteLyrics,
} from './file-ops.js';
import { observeRemoteLww } from './hlc.js';
import {
  type LwwTriple,
  cmpLww,
  isSelfReplay,
  makeLwwTriple,
  readMembershipLww,
  readPlaylistLww,
  readSongLww,
} from './lww.js';
import {
  type ParsedChange,
  PayloadValidationError,
  UnknownChangeError,
  parseChange,
} from './payloads/index.js';
import {
  clearTombstone,
  effectiveKey,
  parentGateOpen,
  readTombstone,
  writeTombstone,
} from './tombstones.js';

/** One change as the server hands it back (skybridge `ServerChange`). */
export interface InboundChange {
  server_seq: number;
  device_id: string;
  client_change_id: string;
  entity_type: string;
  entity_id: string;
  op: string;
  payload: unknown;
  client_local_seq?: number;
  client_created_at?: number;
  server_received_at?: number;
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  deadLettered: number;
  conflicts: number;
  /** Journal rows written — the caller drains them after the commit. */
  fileOps: number;
  songsTouched: boolean;
  playlistsTouched: boolean;
  /** Songs whose lyrics changed, for the GUI's per-song event. */
  lyricsTouched: string[];
}

export interface ApplyOptions {
  nowMs?: () => number;
}

interface Ctx {
  sqlite: SqliteLike;
  now: () => number;
  result: ApplyResult;
}

/**
 * Apply a pulled batch. ASSUMES the caller's transaction — the cursor advance
 * belongs in it too, so a crash mid-batch replays the whole batch rather than
 * skipping the half it had already committed.
 */
export function applyChangesInTx(
  sqlite: SqliteLike,
  changes: readonly InboundChange[],
  options: ApplyOptions = {},
): ApplyResult {
  const ctx: Ctx = {
    sqlite,
    now: options.nowMs ?? Date.now,
    result: {
      applied: 0,
      skipped: 0,
      deadLettered: 0,
      conflicts: 0,
      fileOps: 0,
      songsTouched: false,
      playlistsTouched: false,
      lyricsTouched: [],
    },
  };

  for (const change of changes) {
    let parsed: ParsedChange;
    try {
      parsed = parseChange(change);
    } catch (err) {
      if (!(err instanceof PayloadValidationError) && !(err instanceof UnknownChangeError))
        throw err;
      // Archived whole, then skipped, and the cursor still advances: one
      // change this build cannot read must never wedge the pull (§3.8).
      recordDeadLetter(sqlite, {
        direction: 'in',
        reason: err instanceof UnknownChangeError ? 'unknown_change' : 'invalid_payload',
        serverSeq: change.server_seq,
        clientChangeId: change.client_change_id,
        deviceId: change.device_id,
        entityType: change.entity_type,
        entityId: change.entity_id,
        op: change.op,
        payload: JSON.stringify(change),
        nowMs: ctx.now(),
      });
      ctx.result.deadLettered += 1;
      ctx.result.skipped += 1;
      continue;
    }
    applyOne(ctx, change, parsed);
  }

  return ctx.result;
}

function applyOne(ctx: Ctx, change: InboundChange, parsed: ParsedChange): void {
  switch (parsed.entityType) {
    case 'song':
      switch (parsed.op) {
        case 'create':
        case 'update': {
          applySongPut(ctx, change, parsed.payload);
          return;
        }
        case 'delete': {
          applySongDelete(ctx, change, parsed.payload);
          return;
        }
        case 'set_lyrics': {
          applySetLyrics(ctx, change, parsed.payload);
          return;
        }
        case 'clear_lyrics': {
          applyClearLyrics(ctx, change);
          return;
        }
      }
      break;
    case 'playlist':
      switch (parsed.op) {
        case 'create':
        case 'update': {
          applyPlaylistPut(ctx, change, parsed.payload);
          return;
        }
        case 'delete': {
          applyPlaylistDelete(ctx, change, parsed.payload);
          return;
        }
        case 'reorder': {
          applyReorder(ctx, change, parsed.payload);
          return;
        }
      }
      break;
    case 'playlist_song':
      switch (parsed.op) {
        case 'create': {
          applyMembershipCreate(ctx, change, parsed.payload);
          return;
        }
        case 'delete': {
          applyMembershipDelete(ctx, change, parsed.payload);
          return;
        }
        case 'set_rank': {
          applySetRank(ctx, change, parsed.payload);
          return;
        }
      }
      break;
  }
}

const incomingKey = (
  payload: { updated_at_ms: number; lww_counter: number },
  change: InboundChange,
): LwwTriple => makeLwwTriple(payload.updated_at_ms, payload.lww_counter, change.device_id);

// ─── song ──────────────────────────────────────────────

interface SongRowSnapshot {
  name: string;
  artist: string;
  source_url: string | null;
  source_provider: string | null;
  source_key: string | null;
  file_origin: AudioOrigin;
  lyrics_offset: number;
  duration: number;
  created_at: number;
  updated_at: number;
  lww_counter: number;
  device_id: string | null;
}

function readSongRow(ctx: Ctx, id: string): SongRowSnapshot | null {
  return (
    (ctx.sqlite
      .prepare(
        `SELECT name, artist, source_url, source_provider, source_key, file_origin,
                lyrics_offset, duration, created_at, updated_at, lww_counter, device_id
         FROM songs WHERE id = ?`,
      )
      .get(id) as SongRowSnapshot | undefined) ?? null
  );
}

function applySongPut(ctx: Ctx, change: InboundChange, payload: SongSyncPayload): void {
  const key = incomingKey(payload, change);
  observeRemoteLww(ctx.sqlite, key);

  if (isSelfReplay(ctx.sqlite, change.client_change_id)) {
    skip(ctx);
    return;
  }
  // A song's delete is final: a create that lost to it is a stale echo, not a
  // wish to bring the song back (§3.2).
  if (readTombstone(ctx.sqlite, 'song', change.entity_id) !== null) {
    skip(ctx);
    return;
  }

  const rowKey = readSongLww(ctx.sqlite, change.entity_id);
  if (rowKey === null) {
    insertSong(ctx, change.entity_id, payload, change.device_id);
    ctx.result.applied += 1;
    ctx.result.songsTouched = true;
    return;
  }
  if (cmpLww(key, rowKey) <= 0) {
    skip(ctx);
    return;
  }

  const before = readSongRow(ctx, change.entity_id);
  updateSong(ctx, change.entity_id, payload, change.device_id);
  ctx.result.applied += 1;
  ctx.result.songsTouched = true;

  if (before !== null) maybeRecordConflict(ctx, change, before, payload, rowKey, key);
}

function insertSong(ctx: Ctx, id: string, payload: SongSyncPayload, deviceId: string | null): void {
  // `file_origin` is local truth, not the workspace's: this device has no file
  // for the song yet, and whatever it eventually gets, it got by downloading.
  ctx.sqlite
    .prepare(
      `INSERT INTO songs (id, name, artist, source_url, source_provider, source_key,
         file_origin, lyrics_offset, duration, pinned, last_accessed_at,
         created_at, updated_at, device_id, lww_counter)
       VALUES (?, ?, ?, ?, ?, ?, 'downloaded', ?, ?, 0, NULL, ?, ?, ?, ?)`,
    )
    .run(
      id,
      payload.name,
      payload.artist,
      payload.source_url,
      payload.source_provider,
      payload.source_key,
      payload.lyrics_offset,
      payload.duration,
      payload.created_at_ms,
      payload.updated_at_ms,
      deviceId,
      payload.lww_counter,
    );
}

function updateSong(ctx: Ctx, id: string, payload: SongSyncPayload, deviceId: string | null): void {
  // `created_at` is deliberately absent: it is immutable across the workspace
  // (§3.1), and adopting a peer's value on every update would make two devices
  // that created "the same" song flip it back and forth forever.
  ctx.sqlite
    .prepare(
      `UPDATE songs SET name = ?, artist = ?, source_url = ?, source_provider = ?,
         source_key = ?, lyrics_offset = ?, duration = ?, updated_at = ?,
         lww_counter = ?, device_id = ?
       WHERE id = ?`,
    )
    .run(
      payload.name,
      payload.artist,
      payload.source_url,
      payload.source_provider,
      payload.source_key,
      payload.lyrics_offset,
      payload.duration,
      payload.updated_at_ms,
      payload.lww_counter,
      deviceId,
      id,
    );
}

/**
 * A receipt for the copy the user just lost — but only when they could
 * actually notice: their own edit was still unpushed, and the two versions
 * really differ (§4.6).
 */
function maybeRecordConflict(
  ctx: Ctx,
  change: InboundChange,
  before: SongRowSnapshot,
  payload: SongSyncPayload,
  localKey: LwwTriple,
  remoteKey: LwwTriple,
): void {
  const pending = ctx.sqlite
    .prepare(
      `SELECT 1 FROM sync_changes
       WHERE entity_type='song' AND entity_id=? AND op IN ('create','update')
         AND synced_at IS NULL
       LIMIT 1`,
    )
    .get(change.entity_id);
  if (pending === undefined) return;

  const localPayload: SongSyncPayload = {
    name: before.name,
    artist: before.artist,
    source_url: before.source_url,
    source_provider: before.source_provider,
    source_key: before.source_key,
    lyrics_offset: before.lyrics_offset,
    duration: before.duration,
    created_at_ms: before.created_at,
    updated_at_ms: before.updated_at,
    lww_counter: before.lww_counter,
  };
  const differs = (
    [
      'name',
      'artist',
      'source_url',
      'source_provider',
      'source_key',
      'lyrics_offset',
      'duration',
    ] as const
  ).some((field) => localPayload[field] !== payload[field]);
  if (!differs) return;

  recordConflict(ctx.sqlite, {
    entityType: 'song',
    entityId: change.entity_id,
    remoteSeq: change.server_seq,
    local: {
      payload: localPayload,
      key: {
        updated_at_ms: localKey.ms,
        lww_counter: localKey.counter,
        device_id: localKey.deviceId === '' ? null : localKey.deviceId,
      },
    },
    remote: {
      payload,
      key: {
        updated_at_ms: remoteKey.ms,
        lww_counter: remoteKey.counter,
        device_id: remoteKey.deviceId === '' ? null : remoteKey.deviceId,
      },
    },
    nowMs: ctx.now(),
  });
  ctx.result.conflicts += 1;
}

function applySongDelete(ctx: Ctx, change: InboundChange, payload: TombstoneSyncPayload): void {
  const key = incomingKey(payload, change);
  observeRemoteLww(ctx.sqlite, key);
  if (isSelfReplay(ctx.sqlite, change.client_change_id)) {
    skip(ctx);
    return;
  }

  // A song's delete wins PERMANENTLY (§3.2 / D6), so it is compared against
  // the tombstone only — never against the row. Comparing against the row
  // would let a device whose edit is a millisecond newer keep a song every
  // other device has already buried: their `applySongPut` refuses any later
  // update once a tombstone exists, so nothing would ever reconcile the two
  // again. (Caught by the dual e2e's delete-versus-edit race.) The tombstone
  // comparison is what keeps a re-delivered older delete idempotent.
  const buried = readTombstone(ctx.sqlite, 'song', change.entity_id)?.key ?? null;
  if (buried !== null && cmpLww(key, buried) <= 0) {
    skip(ctx);
    return;
  }

  // The origin is snapshotted BEFORE the row goes: the executor runs later,
  // with nothing left to read (§3.6). A song this device never had reads as
  // "origin unknown", which the executor treats as irreplaceable.
  const row = readSongRow(ctx, change.entity_id);
  ctx.sqlite.prepare('DELETE FROM songs WHERE id = ?').run(change.entity_id);
  writeTombstone(ctx.sqlite, 'song', change.entity_id, key, ctx.now());
  enqueueRemoteDelete(ctx.sqlite, change.entity_id, row?.file_origin ?? null, ctx.now());

  ctx.result.applied += 1;
  ctx.result.fileOps += 1;
  ctx.result.songsTouched = true;
  ctx.result.playlistsTouched = true; // memberships cascaded with it
}

function applySetLyrics(ctx: Ctx, change: InboundChange, payload: SetLyricsSyncPayload): void {
  if (!parentGateOpen(ctx.sqlite, 'song', change.entity_id)) {
    skip(ctx);
    return;
  }
  // Replayed even when it is our own echo: metadata ops carry no key, so
  // re-landing the same document is how they converge.
  enqueueWriteLyrics(ctx.sqlite, change.entity_id, payload.lrc, ctx.now());
  ctx.result.applied += 1;
  ctx.result.fileOps += 1;
  ctx.result.lyricsTouched.push(change.entity_id);
}

function applyClearLyrics(ctx: Ctx, change: InboundChange): void {
  if (!parentGateOpen(ctx.sqlite, 'song', change.entity_id)) {
    skip(ctx);
    return;
  }
  enqueueDeleteLyrics(ctx.sqlite, change.entity_id, ctx.now());
  ctx.result.applied += 1;
  ctx.result.fileOps += 1;
  ctx.result.lyricsTouched.push(change.entity_id);
}

// ─── playlist ──────────────────────────────────────────

function applyPlaylistPut(ctx: Ctx, change: InboundChange, payload: PlaylistSyncPayload): void {
  const key = incomingKey(payload, change);
  observeRemoteLww(ctx.sqlite, key);
  if (isSelfReplay(ctx.sqlite, change.client_change_id)) {
    skip(ctx);
    return;
  }
  if (readTombstone(ctx.sqlite, 'playlist', change.entity_id) !== null) {
    skip(ctx);
    return;
  }

  const rowKey = readPlaylistLww(ctx.sqlite, change.entity_id);
  if (rowKey === null) {
    ctx.sqlite
      .prepare(
        `INSERT INTO playlists (id, name, created_at, updated_at, device_id, lww_counter)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        change.entity_id,
        payload.name,
        payload.created_at_ms,
        payload.updated_at_ms,
        change.device_id,
        payload.lww_counter,
      );
  } else {
    if (cmpLww(key, rowKey) <= 0) {
      skip(ctx);
      return;
    }
    ctx.sqlite
      .prepare(
        'UPDATE playlists SET name = ?, updated_at = ?, lww_counter = ?, device_id = ? WHERE id = ?',
      )
      .run(
        payload.name,
        payload.updated_at_ms,
        payload.lww_counter,
        change.device_id,
        change.entity_id,
      );
  }
  ctx.result.applied += 1;
  ctx.result.playlistsTouched = true;
}

function applyPlaylistDelete(ctx: Ctx, change: InboundChange, payload: TombstoneSyncPayload): void {
  const key = incomingKey(payload, change);
  observeRemoteLww(ctx.sqlite, key);
  if (isSelfReplay(ctx.sqlite, change.client_change_id)) {
    skip(ctx);
    return;
  }

  // Permanent, same as a song's (§3.2): the tombstone alone decides whether
  // this delete has already been applied.
  const buried = readTombstone(ctx.sqlite, 'playlist', change.entity_id)?.key ?? null;
  if (buried !== null && cmpLww(key, buried) <= 0) {
    skip(ctx);
    return;
  }

  // Memberships cascade by foreign key and get no tombstones of their own:
  // every device applying this delete cascades its own copies (§3.2).
  ctx.sqlite.prepare('DELETE FROM playlists WHERE id = ?').run(change.entity_id);
  writeTombstone(ctx.sqlite, 'playlist', change.entity_id, key, ctx.now());
  ctx.result.applied += 1;
  ctx.result.playlistsTouched = true;
}

/**
 * Adopt a peer's order (§3.5).
 *
 * Ids repeated in the list keep their first position, ids this device does not
 * have are ignored, and members the list does not mention keep their relative
 * order at the tail — a peer that is mid-sync knows a different set of songs
 * than this device, and neither "drop what it did not mention" nor "refuse the
 * whole list" is a sane reading of a reorder.
 */
function applyReorder(ctx: Ctx, change: InboundChange, payload: ReorderSyncPayload): void {
  if (!parentGateOpen(ctx.sqlite, 'playlist', change.entity_id)) {
    skip(ctx);
    return;
  }

  const members = ctx.sqlite
    .prepare(
      `SELECT song_id FROM playlist_songs WHERE playlist_id = ?
       ORDER BY rank, song_id`,
    )
    .all(change.entity_id) as { song_id: string }[];
  const local = new Set(members.map((m) => m.song_id));

  const ordered: string[] = [];
  const placed = new Set<string>();
  for (const songId of payload.song_ids) {
    if (placed.has(songId) || !local.has(songId)) continue;
    ordered.push(songId);
    placed.add(songId);
  }
  for (const { song_id } of members) {
    if (!placed.has(song_id)) ordered.push(song_id);
  }

  const write = ctx.sqlite.prepare(
    'UPDATE playlist_songs SET rank = ? WHERE playlist_id = ? AND song_id = ?',
  );
  ordered.forEach((songId, index) => {
    write.run((index + 1) * RANK_STEP, change.entity_id, songId);
  });

  ctx.result.applied += 1;
  ctx.result.playlistsTouched = true;
}

// ─── playlist_song ─────────────────────────────────────

function membershipParents(entityId: string): { playlistId: string; songId: string } {
  const [playlistId, songId] = entityId.split(':');
  return { playlistId, songId };
}

function membershipGateOpen(ctx: Ctx, entityId: string): boolean {
  const { playlistId, songId } = membershipParents(entityId);
  return (
    parentGateOpen(ctx.sqlite, 'playlist', playlistId) && parentGateOpen(ctx.sqlite, 'song', songId)
  );
}

function applyMembershipCreate(
  ctx: Ctx,
  change: InboundChange,
  payload: PlaylistSongSyncPayload,
): void {
  if (!membershipGateOpen(ctx, change.entity_id)) {
    skip(ctx);
    return;
  }

  const key = incomingKey(payload, change);
  observeRemoteLww(ctx.sqlite, key);
  if (isSelfReplay(ctx.sqlite, change.client_change_id)) {
    skip(ctx);
    return;
  }

  const rowKey = readMembershipLww(ctx.sqlite, payload.playlist_id, payload.song_id);
  if (rowKey !== null) {
    // Branch 1 (R5-1): the membership already exists here — two devices added
    // the same song. Only the LWW triple moves; `added_at` and `rank` are what
    // this device already believes. Skipping instead would leave the two
    // devices holding different keys for the same live row, and a delete
    // arriving between them would then apply on one and not the other.
    if (cmpLww(key, rowKey) <= 0) {
      skip(ctx);
      return;
    }
    ctx.sqlite
      .prepare(
        `UPDATE playlist_songs SET updated_at = ?, lww_counter = ?, device_id = ?
         WHERE playlist_id = ? AND song_id = ?`,
      )
      .run(
        payload.updated_at_ms,
        payload.lww_counter,
        change.device_id,
        payload.playlist_id,
        payload.song_id,
      );
    ctx.result.applied += 1;
    ctx.result.playlistsTouched = true;
    return;
  }

  // Branch 3: it lost to the tombstone. Its paired `set_rank` is stopped by
  // the row-exists gate below, so nothing else has to remember this happened.
  const grave = readTombstone(ctx.sqlite, 'playlist_song', change.entity_id)?.key ?? null;
  if (grave !== null && cmpLww(key, grave) <= 0) {
    skip(ctx);
    return;
  }

  // Branch 2: insert or revive. The rank here is a PLACEHOLDER — the paired
  // `set_rank` decides the real position, and until it arrives the song sits
  // at the tail rather than at some arbitrary point in the list.
  const tail = ctx.sqlite
    .prepare('SELECT max(rank) AS max_rank FROM playlist_songs WHERE playlist_id = ?')
    .get(payload.playlist_id) as { max_rank: number | null };
  ctx.sqlite
    .prepare(
      `INSERT INTO playlist_songs (playlist_id, song_id, rank, added_at, updated_at,
         device_id, lww_counter)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      payload.playlist_id,
      payload.song_id,
      (tail.max_rank ?? 0) + RANK_STEP,
      payload.added_at_ms,
      payload.updated_at_ms,
      change.device_id,
      payload.lww_counter,
    );
  clearTombstone(ctx.sqlite, 'playlist_song', change.entity_id);
  ctx.result.applied += 1;
  ctx.result.playlistsTouched = true;
}

function applyMembershipDelete(
  ctx: Ctx,
  change: InboundChange,
  payload: TombstoneSyncPayload,
): void {
  const key = incomingKey(payload, change);
  observeRemoteLww(ctx.sqlite, key);
  if (isSelfReplay(ctx.sqlite, change.client_change_id)) {
    skip(ctx);
    return;
  }

  const { playlistId, songId } = membershipParents(change.entity_id);
  const current = effectiveKey(
    readMembershipLww(ctx.sqlite, playlistId, songId),
    readTombstone(ctx.sqlite, 'playlist_song', change.entity_id)?.key ?? null,
  );
  if (current !== null && cmpLww(key, current) <= 0) {
    skip(ctx);
    return;
  }

  ctx.sqlite
    .prepare('DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?')
    .run(playlistId, songId);
  // Unlike a cascade, this one is revivable: a later `create` that beats this
  // key puts the song back in the playlist.
  writeTombstone(ctx.sqlite, 'playlist_song', change.entity_id, key, ctx.now());
  ctx.result.applied += 1;
  ctx.result.playlistsTouched = true;
}

function applySetRank(ctx: Ctx, change: InboundChange, payload: SetRankSyncPayload): void {
  if (!membershipGateOpen(ctx, change.entity_id)) {
    skip(ctx);
    return;
  }

  const { playlistId, songId } = membershipParents(change.entity_id);
  // The row-exists gate. It also does the second job named in §3.2: a `create`
  // that lost to a tombstone leaves its paired `set_rank` with nothing to
  // write, and that is exactly what should happen.
  const changed = ctx.sqlite
    .prepare('UPDATE playlist_songs SET rank = ? WHERE playlist_id = ? AND song_id = ?')
    .run(payload.rank, playlistId, songId);
  if (changed.changes === 0) {
    skip(ctx);
    return;
  }

  ctx.result.applied += 1;
  ctx.result.playlistsTouched = true;
}

function skip(ctx: Ctx): void {
  ctx.result.skipped += 1;
}
