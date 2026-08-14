// Songs CRUD (T4) — core's single write path (R18/R2). Business writes stamp
// the LWW key from the device-global hybrid clock and carry the skybridge
// device id; local-field paths (pin / touch / file origin) never touch the LWW
// triple, so device-local behavior cannot pollute a comparison another machine
// makes. Write functions come in two layers: `…InTx` assumes the caller's
// transaction (M5 composes several into one all-or-nothing import), the
// same-named wrapper opens `.immediate()`.
//
// Since v0.2 every business write also appends to the outbox in that same
// transaction, and `deleteSong` records a tombstone plus a file-effect journal
// entry instead of doing its own trash-directory dance (§3.6).

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type FileOrigin,
  type SongData,
  type SongSortField,
  type SongSyncPayload,
  type SortOrder,
  isUuidV4,
} from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { and, eq, ne, sql } from 'drizzle-orm';
import { type LarkDatabase, sqliteOf } from '../db/index.js';
import { type SongRow, songs } from '../db/schema.js';
import { InvalidIdError, NotFoundError, SourceKeyConflictError } from '../errors.js';
import { songsDir } from '../paths.js';
import { emitSyncChange } from '../sync/changes.js';
import { readSkybridgeDeviceId } from '../sync/device.js';
import { FileEffectRuntime, enqueueLocalDelete } from '../sync/file-ops.js';
import { nextSyncStamp } from '../sync/hlc.js';
import { makeLwwTriple } from '../sync/lww.js';
import { writeTombstone } from '../sync/tombstones.js';
import { CANONICAL_AUDIO_FILE, LEGACY_AUDIO_FILE } from './lyrics.js';
import { type SourceInput, normalizeSource } from './source.js';

export interface CreateSongInput extends SourceInput {
  name: string;
  artist?: string;
  lyrics_offset?: number;
  duration?: number;
}

export interface UpdateSongInput extends SourceInput {
  name?: string;
  artist?: string;
  lyrics_offset?: number;
  duration?: number;
}

export interface ListSongsOptions {
  /** Substring match against name OR artist (LIKE, escaped). */
  search?: string;
  /** Domain shared with the daemon's query validator (M2-16). */
  sort?: SongSortField;
  order?: SortOrder;
  limit?: number;
  offset?: number;
}

export interface ListSongsResult {
  songs: SongData[];
  /** Filtered count before pagination (envelope total). */
  total: number;
}

export interface SongFileInfo {
  has_file: boolean;
  file_size?: number;
}

/** Chinese-aware collation for name/artist sorting (SQLite can't, hence the JS sort). */
const ZH_COLLATOR = new Intl.Collator('zh-CN');

function toSongData(row: SongRow): SongData {
  return {
    id: row.id,
    name: row.name,
    artist: row.artist,
    source_url: row.source_url,
    source_provider: row.source_provider,
    source_key: row.source_key,
    file_origin: row.file_origin,
    lyrics_offset: row.lyrics_offset,
    duration: row.duration,
    pinned: row.pinned,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getSongRow(db: LarkDatabase, id: string): SongRow {
  const row = db.select().from(songs).where(eq(songs.id, id)).get();
  if (!row) throw new NotFoundError('song', id);
  return row;
}

/** The wire form of a song row — the payload of every `create` / `update`. */
function songSyncPayload(row: SongRow): SongSyncPayload {
  return {
    name: row.name,
    artist: row.artist,
    source_url: row.source_url,
    source_provider: row.source_provider,
    source_key: row.source_key,
    lyrics_offset: row.lyrics_offset,
    duration: row.duration,
    created_at_ms: row.created_at,
    updated_at_ms: row.updated_at,
    lww_counter: row.lww_counter,
  };
}

/**
 * Throw SourceKeyConflictError if (provider, key) belongs to another song.
 *
 * Local paths keep refusing duplicates even though the database no longer
 * does (D8 dropped the UNIQUE index): sync may be forced to accept a duplicate
 * two offline devices created, but nothing on THIS machine has to create one.
 */
function assertKeyFree(db: LarkDatabase, provider: string, key: string, excludeId?: string): void {
  const conditions = [eq(songs.source_provider, provider), eq(songs.source_key, key)];
  if (excludeId !== undefined) conditions.push(ne(songs.id, excludeId));
  const conflict = db
    .select({ id: songs.id })
    .from(songs)
    .where(and(...conditions))
    .get();
  if (conflict) throw new SourceKeyConflictError(conflict.id, provider, key);
}

export function createSongInTx(db: LarkDatabase, input: CreateSongInput): SongData {
  return insertSongRow(db, {
    id: randomUUID(),
    input,
    fileOrigin: 'downloaded',
  });
}

/**
 * The one place a song row is born: stamp, insert, emit — in that order, in
 * the caller's transaction.
 *
 * `created_at` takes the same hybrid-clock value as `updated_at` rather than a
 * bare `Date.now()`, so the row and the `create` payload agree on the moment
 * the song came into existence. `created_at_ms` is immutable across the
 * workspace, and a value that disagreed with the key would be a permanent
 * inconsistency nothing later can fix.
 */
function insertSongRow(
  db: LarkDatabase,
  args: { id: string; input: CreateSongInput; fileOrigin: FileOrigin },
): SongData {
  const sqlite = sqliteOf(db);
  const src = normalizeSource(args.input);
  if (src.source_provider !== null && src.source_key !== null) {
    assertKeyFree(db, src.source_provider, src.source_key);
  }
  const stamp = nextSyncStamp(sqlite);
  const row: SongRow = {
    id: args.id,
    name: args.input.name,
    artist: args.input.artist ?? '',
    ...src,
    file_origin: args.fileOrigin,
    lyrics_offset: args.input.lyrics_offset ?? 0,
    duration: args.input.duration ?? 0,
    pinned: false,
    last_accessed_at: null,
    created_at: stamp.updated_at,
    updated_at: stamp.updated_at,
    device_id: readSkybridgeDeviceId(sqlite),
    lww_counter: stamp.lww_counter,
  };
  db.insert(songs).values(row).run();
  emitSyncChange(sqlite, {
    entityType: 'song',
    entityId: row.id,
    op: 'create',
    payload: songSyncPayload(row),
  });
  return toSongData(row);
}

export function createSong(
  db: LarkDatabase,
  sqlite: BetterSqlite3.Database,
  input: CreateSongInput,
): SongData {
  return sqlite.transaction(() => createSongInTx(db, input)).immediate();
}

/**
 * INTERNAL CAPABILITY — M3's download and import paths only, and only from
 * inside the landing transaction (M3-7).
 *
 * `createSongInTx` mints the id itself and commits immediately, which the R22
 * ordering cannot use: the file has to land at `songs/<id>/` BEFORE the row
 * exists, so the id must be known first. This variant takes the pre-allocated
 * id and the origin of the file that is already on disk — the ONLY two things
 * that differ. Everything else, including the source-key uniqueness check,
 * goes through the same code.
 */
export function createFileBackedSongInTx(
  db: LarkDatabase,
  input: CreateSongInput & { id: string; file_origin: FileOrigin },
): SongData {
  if (!isUuidV4(input.id)) throw new InvalidIdError(input.id);
  return insertSongRow(db, { id: input.id, input, fileOrigin: input.file_origin });
}

export function getSong(db: LarkDatabase, _sqlite: BetterSqlite3.Database, id: string): SongData {
  return toSongData(getSongRow(db, id));
}

export function updateSongInTx(db: LarkDatabase, id: string, patch: UpdateSongInput): SongData {
  const sqlite = sqliteOf(db);
  const prev = getSongRow(db, id);
  const src = normalizeSource({
    source_url: patch.source_url !== undefined ? patch.source_url : prev.source_url,
    source_provider:
      patch.source_provider !== undefined ? patch.source_provider : prev.source_provider,
    source_key: patch.source_key !== undefined ? patch.source_key : prev.source_key,
  });
  // Only a CHANGED key is checked (D8). Sync can legitimately deliver a second
  // song holding this one's key, and re-checking an unchanged key would make
  // renaming such a song impossible — a conflict the user did not create and
  // cannot fix from the edit dialog.
  const keyChanged =
    src.source_provider !== prev.source_provider || src.source_key !== prev.source_key;
  if (keyChanged && src.source_provider !== null && src.source_key !== null) {
    assertKeyFree(db, src.source_provider, src.source_key, id);
  }
  const stamp = nextSyncStamp(sqlite);
  const next: SongRow = {
    ...prev,
    name: patch.name ?? prev.name,
    artist: patch.artist ?? prev.artist,
    lyrics_offset: patch.lyrics_offset ?? prev.lyrics_offset,
    duration: patch.duration ?? prev.duration,
    ...src,
    updated_at: stamp.updated_at,
    lww_counter: stamp.lww_counter,
    device_id: readSkybridgeDeviceId(sqlite),
  };
  db.update(songs)
    .set({
      name: next.name,
      artist: next.artist,
      lyrics_offset: next.lyrics_offset,
      duration: next.duration,
      source_url: next.source_url,
      source_provider: next.source_provider,
      source_key: next.source_key,
      updated_at: next.updated_at,
      lww_counter: next.lww_counter,
      device_id: next.device_id,
    })
    .where(eq(songs.id, id))
    .run();
  emitSyncChange(sqlite, {
    entityType: 'song',
    entityId: id,
    op: 'update',
    payload: songSyncPayload(next),
  });
  return toSongData(next);
}

export function updateSong(
  db: LarkDatabase,
  sqlite: BetterSqlite3.Database,
  id: string,
  patch: UpdateSongInput,
): SongData {
  return sqlite.transaction(() => updateSongInTx(db, id, patch)).immediate();
}

/**
 * Filter → full fetch → JS sort → slice (T4 pipeline, locked): SQLite can't
 * collate Chinese, so ORDER BY + LIMIT in SQL would paginate before the real
 * order exists. The library is small (tens to hundreds); a full sort is fine.
 * Tie-break is ALWAYS `id` ascending, regardless of the primary direction, so
 * pagination cuts are stable.
 */
export function listSongs(
  db: LarkDatabase,
  _sqlite: BetterSqlite3.Database,
  options: ListSongsOptions = {},
): ListSongsResult {
  const { search, sort = 'created_at', order = 'asc', limit, offset = 0 } = options;

  let rows: SongRow[];
  if (search !== undefined && search !== '') {
    // Escape the escape char itself first, then the LIKE wildcards.
    const escaped = search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%${escaped}%`;
    rows = db
      .select()
      .from(songs)
      .where(
        sql`(${songs.name} LIKE ${pattern} ESCAPE '\\' OR ${songs.artist} LIKE ${pattern} ESCAPE '\\')`,
      )
      .all();
  } else {
    rows = db.select().from(songs).all();
  }

  const dir = order === 'desc' ? -1 : 1;
  rows.sort((a, b) => {
    const cmp =
      sort === 'created_at' ? a.created_at - b.created_at : ZH_COLLATOR.compare(a[sort], b[sort]);
    if (cmp !== 0) return dir * cmp;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const total = rows.length;
  const page = limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + limit);
  return { songs: page.map(toSongData), total };
}

export interface DeleteSongOptions {
  /**
   * The runtime that executes the queued file removal. A caller that already
   * holds this song's claim passes ITS runtime (constructed with its own
   * owner), so the drain reuses that claim instead of blocking on it.
   */
  fileOps?: FileEffectRuntime;
}

/**
 * Delete a song: one transaction for the row, the tombstone, the outbox entry
 * and the file-effect journal — then execute the file removal.
 *
 * v0.1 staged the directory into `trash/` first and renamed it back if the
 * database write failed. The journal replaces that compensation outright: the
 * transaction is the commit point, and after it the files are owed rather than
 * gone-and-maybe-restored. A crash between the two now resolves at boot, in
 * one direction, instead of leaving a staged directory nobody will look at.
 *
 * The tombstone matters as much as the delete. Retention will eventually trim
 * the outbox row, and after that the tombstone is the only evidence that a
 * peer's older `create` for this id is a stale echo rather than a new song.
 */
export async function deleteSong(
  db: LarkDatabase,
  sqlite: BetterSqlite3.Database,
  id: string,
  options: DeleteSongOptions = {},
): Promise<void> {
  if (!isUuidV4(id)) throw new InvalidIdError(id);

  sqlite
    .transaction(() => {
      getSongRow(db, id); // 404 before anything is written
      const stamp = nextSyncStamp(sqlite);
      const deviceId = readSkybridgeDeviceId(sqlite);

      // Memberships cascade; they get no tombstones and emit nothing — a peer
      // applying the song's delete cascades its own (§3.2).
      db.delete(songs).where(eq(songs.id, id)).run();

      writeTombstone(
        sqlite,
        'song',
        id,
        makeLwwTriple(stamp.updated_at, stamp.lww_counter, deviceId),
        stamp.updated_at,
      );
      emitSyncChange(sqlite, {
        entityType: 'song',
        entityId: id,
        op: 'delete',
        payload: { updated_at_ms: stamp.updated_at, lww_counter: stamp.lww_counter },
      });
      // policy 'local': this device's own user asked for it, so nothing needs
      // rescuing — unlike a delete that arrives from a peer (§3.6).
      enqueueLocalDelete(sqlite, id, stamp.updated_at);
    })
    .immediate();

  const runtime = options.fileOps ?? new FileEffectRuntime({ sqlite });
  await runtime.drain();
}

// ─── Local-field paths (R18) ───────────────────────────
//
// pinned / last_accessed_at / file_origin are device-local data: these
// setters never touch updated_at / lww_counter / device_id, so local behavior
// can't pollute LWW comparison. Single-statement writes — they compose into
// any enclosing transaction as-is.

export function setPinned(
  db: LarkDatabase,
  _sqlite: BetterSqlite3.Database,
  id: string,
  pinned: boolean,
): void {
  const res = db.update(songs).set({ pinned }).where(eq(songs.id, id)).run();
  if (res.changes === 0) throw new NotFoundError('song', id);
}

export function touchLastAccessed(
  db: LarkDatabase,
  _sqlite: BetterSqlite3.Database,
  id: string,
  at = Date.now(),
): void {
  const res = db.update(songs).set({ last_accessed_at: at }).where(eq(songs.id, id)).run();
  if (res.changes === 0) throw new NotFoundError('song', id);
}

/**
 * INTERNAL CAPABILITY — not for routes or the CLI surface. Only M3's
 * download/import file-write paths may call this, after their atomic file
 * landing succeeds: flipping an imported song to 'downloaded' moves it into
 * the evictable set (R1), so a stray caller could silently make user assets
 * reclaimable. (T5's migration writes file_origin='imported' at row-insert
 * time and does not pass through here.)
 */
export function setFileOrigin(
  db: LarkDatabase,
  _sqlite: BetterSqlite3.Database,
  id: string,
  origin: 'downloaded' | 'imported',
): void {
  const res = db.update(songs).set({ file_origin: origin }).where(eq(songs.id, id)).run();
  if (res.changes === 0) throw new NotFoundError('song', id);
}

/**
 * Which audio file names count as "the song has its file".
 *
 * `canonical` — `song.m4a`, the only answer once the library is migrated.
 * `migration-pending` — also accept `song.mp3`, for the window where 0003 has
 * stamped the schema but the conversion pass has not reached this song yet.
 * A song waiting its turn is not a song to offer a download for.
 */
export type AudioMode = 'canonical' | 'migration-pending';

/**
 * Disk probe for the wire enrich fields (has_file / file_size).
 *
 * The mode is a parameter and never read from the database here: this is a
 * path function, callers know whether their library is mid-migration (the
 * daemon closes business routes during it; the CLI's direct backend reads the
 * flag), and a function that quietly opened a database to answer a stat would
 * be a second source of truth.
 */
export function songFileInfo(id: string, options: { audioMode: AudioMode }): SongFileInfo {
  if (!isUuidV4(id)) throw new InvalidIdError(id);
  const names =
    options.audioMode === 'canonical'
      ? [CANONICAL_AUDIO_FILE]
      : [CANONICAL_AUDIO_FILE, LEGACY_AUDIO_FILE];
  for (const name of names) {
    try {
      const st = statSync(join(songsDir(), id, name));
      return { has_file: true, file_size: st.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return { has_file: false };
}
