// Songs CRUD (T4) — core's single write path (R18/R2). Business writes stamp
// LWW via nextLwwStamp and keep device_id NULL (it belongs to the skybridge
// registration domain); local-field paths (pin / touch / file origin) never
// touch the LWW triple. Write functions come in two layers: `…InTx` assumes
// the caller's transaction (M5 composes several into one all-or-nothing
// import), the same-named wrapper opens `.immediate()`. `deleteSong` is the
// deliberate exception — its trash-dir compensation must own its transaction,
// so it offers NO composable variant (M1-8/T4).

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type SongData, type SongSortField, type SortOrder, isUuidV4 } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { LarkDatabase } from '../db/index.js';
import { nextLwwStamp } from '../db/lww.js';
import { type SongRow, songs } from '../db/schema.js';
import { InvalidIdError, NotFoundError, SourceKeyConflictError } from '../errors.js';
import { songsDir, trashDir } from '../paths.js';
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

/** Throw SourceKeyConflictError if (provider, key) belongs to another song. */
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
  const src = normalizeSource(input);
  if (src.source_provider !== null && src.source_key !== null) {
    assertKeyFree(db, src.source_provider, src.source_key);
  }
  const now = Date.now();
  const row: SongRow = {
    id: randomUUID(),
    name: input.name,
    artist: input.artist ?? '',
    ...src,
    file_origin: 'downloaded',
    lyrics_offset: input.lyrics_offset ?? 0,
    duration: input.duration ?? 0,
    pinned: false,
    last_accessed_at: null,
    created_at: now,
    updated_at: now,
    device_id: null,
    lww_counter: 0,
  };
  db.insert(songs).values(row).run();
  return toSongData(row);
}

export function createSong(
  db: LarkDatabase,
  sqlite: BetterSqlite3.Database,
  input: CreateSongInput,
): SongData {
  return sqlite.transaction(() => createSongInTx(db, input)).immediate();
}

export function getSong(db: LarkDatabase, _sqlite: BetterSqlite3.Database, id: string): SongData {
  return toSongData(getSongRow(db, id));
}

export function updateSongInTx(db: LarkDatabase, id: string, patch: UpdateSongInput): SongData {
  const prev = getSongRow(db, id);
  const src = normalizeSource({
    source_url: patch.source_url !== undefined ? patch.source_url : prev.source_url,
    source_provider:
      patch.source_provider !== undefined ? patch.source_provider : prev.source_provider,
    source_key: patch.source_key !== undefined ? patch.source_key : prev.source_key,
  });
  if (src.source_provider !== null && src.source_key !== null) {
    assertKeyFree(db, src.source_provider, src.source_key, id);
  }
  const stamp = nextLwwStamp(prev);
  const next: SongRow = {
    ...prev,
    name: patch.name ?? prev.name,
    artist: patch.artist ?? prev.artist,
    lyrics_offset: patch.lyrics_offset ?? prev.lyrics_offset,
    duration: patch.duration ?? prev.duration,
    ...src,
    updated_at: stamp.updated_at,
    lww_counter: stamp.lww_counter,
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
    })
    .where(eq(songs.id, id))
    .run();
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

/**
 * Two-phase delete (R22): stage the song directory into trash/, commit the DB
 * delete (memberships cascade), then remove the staged directory best-effort
 * in the background. A DB failure renames the directory back in place. No
 * `…InTx` variant on purpose — an enclosing transaction's rollback would
 * orphan the compensation.
 */
export function deleteSong(db: LarkDatabase, sqlite: BetterSqlite3.Database, id: string): void {
  if (!isUuidV4(id)) throw new InvalidIdError(id);
  getSongRow(db, id);

  const songDir = join(songsDir(), id);
  let staged: string | null = null;
  if (existsSync(songDir)) {
    mkdirSync(trashDir(), { recursive: true });
    staged = join(trashDir(), `${id}-${Date.now()}`);
    renameSync(songDir, staged);
  }

  try {
    sqlite
      .transaction(() => {
        db.delete(songs).where(eq(songs.id, id)).run();
      })
      .immediate();
  } catch (err) {
    if (staged !== null) {
      renameSync(staged, songDir);
    }
    throw err;
  }

  if (staged !== null) {
    void rm(staged, { recursive: true, force: true }).catch(() => {
      /* best-effort: an undeleted trash entry is harmless and retried never */
    });
  }
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

/** Disk probe for the wire enrich fields (has_file / file_size). */
export function songFileInfo(id: string): SongFileInfo {
  if (!isUuidV4(id)) throw new InvalidIdError(id);
  try {
    const st = statSync(join(songsDir(), id, 'song.mp3'));
    return { has_file: true, file_size: st.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { has_file: false };
    throw err;
  }
}
