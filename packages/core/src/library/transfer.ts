// Playlist export / import (M5-12 / M5-13), master plan §5.3.
//
// The interchange file is deliberately id-free: an import mints fresh UUIDs
// (R10), so identity across libraries rests on `(source_provider, source_key)`
// alone — which is why the file carries the pair explicitly instead of leaving
// it to be re-derived from the url (R27).
//
// Three rules decide what an entry becomes, in this order:
//
//   1. A `(provider, key)` hit in the library REUSES that song. Always, and
//      regardless of what the caller asked for: R12 says the key is identity,
//      so a `reuse` instruction cannot override it and neither can a library
//      that gained the song between preview and commit.
//   2. A key already seen EARLIER IN THE SAME FILE reuses whatever that entry
//      resolved to. Without this, importing two entries that share a key into
//      an empty library previews as two new songs and commits as one.
//   3. Everything else is a NEW song. Same name+artist under a different key
//      is a suspect, not a match — live cuts and remixes are the common case,
//      so merging is opt-in per entry (R12).
//
// `computeMatches` is the single implementation of all three, shared by the
// preview and the commit. The commit RE-RUNS it rather than trusting the
// preview's verdict; the digest is what makes the two agree on what `index`
// means.

import {
  type ImportCandidate,
  type ImportSuspect,
  PLAYLIST_EXPORT_FORMAT,
  PLAYLIST_EXPORT_VERSION,
  type PlaylistExportData,
  type PlaylistExportSong,
  type PlaylistImportData,
  type PlaylistImportPreviewData,
} from '@lark/shared';
import { and, eq } from 'drizzle-orm';
import {
  InvalidImportFileError,
  InvalidReuseError,
  InvalidSourceError,
  NotFoundError,
  UnsupportedFormatVersionError,
} from '../errors.js';
import type { PortableDrizzle } from '../portable/db.js';
import type { PortableDb } from '../portable/db.js';
import { sha256BytesAsync } from '../portable/runtime/digest.js';
import { decodeUtf8 } from '../portable/runtime/text.js';
import { type SongRow, playlist_songs, playlists, songs } from '../portable/schema.js';
import { addSongsToPlaylistInTx, createPlaylistInTx } from './playlists.js';
import { createSongInTx, songFileInfo } from './songs.js';
import { findSongByKey, normalizeSource } from './source.js';

/** Guardrails on one file, mirrored by the route's byte-size check (M5-13). */
export const IMPORT_SONGS_MAX = 10_000;
const NAME_MAX = 500;
const URL_MAX = 2048;
const PROVIDER_MAX = 64;
const KEY_MAX = 256;

// ─── Export ────────────────────────────────────────────

/**
 * What to export. `playlistId: null` is the whole library, and the caller
 * supplies its name — core has no concept of the API's virtual `all` (R3).
 */
export type ExportSource = { playlistId: string } | { playlistId: null; name: string };

function toExportSong(row: SongRow): PlaylistExportSong {
  return {
    name: row.name,
    artist: row.artist,
    source_url: row.source_url,
    source_provider: row.source_provider,
    source_key: row.source_key,
    lyrics_offset: row.lyrics_offset,
    duration: row.duration,
  };
}

export function buildExport(db: PortableDrizzle, source: ExportSource): PlaylistExportData {
  let name: string;
  let rows: SongRow[];

  if (source.playlistId === null) {
    name = source.name;
    // `created_at, id`: batch-created rows share a millisecond often enough
    // that created_at alone is not a deterministic order.
    rows = db.select().from(songs).orderBy(songs.created_at, songs.id).all();
  } else {
    const playlist = db.select().from(playlists).where(eq(playlists.id, source.playlistId)).get();
    if (!playlist) throw new NotFoundError('playlist', source.playlistId);
    name = playlist.name;
    rows = db
      .select({ song: songs })
      .from(playlist_songs)
      .innerJoin(songs, eq(playlist_songs.song_id, songs.id))
      .where(eq(playlist_songs.playlist_id, source.playlistId))
      .orderBy(playlist_songs.rank, playlist_songs.song_id)
      .all()
      .map((r) => r.song);
  }

  return {
    format: PLAYLIST_EXPORT_FORMAT,
    version: PLAYLIST_EXPORT_VERSION,
    exported_at: Date.now(),
    playlist: { name },
    songs: rows.map(toExportSong),
  };
}

// ─── Parsing ───────────────────────────────────────────

/** One validated file entry — an export song, normalised the way a row is. */
export type ImportEntry = PlaylistExportSong;

export interface ParsedImportFile {
  /** SHA-256 of the bytes, hex. The commit compares it against the preview's. */
  digest: string;
  playlist_name: string;
  entries: ImportEntry[];
}

function bad(message: string): InvalidImportFileError {
  return new InvalidImportFileError(message);
}

function readString(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') throw bad(`${what} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw bad(`${what} 超过 ${max} 个字符`);
  return trimmed;
}

function readNullableString(value: unknown, what: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  const text = readString(value, what, max);
  return text === '' ? null : text;
}

function readNumber(value: unknown, what: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw bad(`${what} 必须是有限数字`);
  }
  return value;
}

function readEntry(raw: unknown, index: number): ImportEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw bad(`songs[${index}] 必须是对象`);
  }
  const entry = raw as Record<string, unknown>;
  const name = readString(entry.name, `songs[${index}].name`, NAME_MAX);
  if (name === '') throw bad(`songs[${index}].name 不能为空`);

  // The source triple goes through the same judge a row does, so a file can
  // never smuggle in a combination the database refuses (M1-8 four quadrants).
  let source: ReturnType<typeof normalizeSource>;
  try {
    source = normalizeSource({
      source_url: readNullableString(entry.source_url, `songs[${index}].source_url`, URL_MAX),
      source_provider: readNullableString(
        entry.source_provider,
        `songs[${index}].source_provider`,
        PROVIDER_MAX,
      ),
      source_key: readNullableString(entry.source_key, `songs[${index}].source_key`, KEY_MAX),
    });
  } catch (err) {
    if (err instanceof InvalidSourceError) throw bad(`songs[${index}]: ${err.message}`);
    throw err;
  }

  return {
    name,
    artist:
      entry.artist === undefined || entry.artist === null
        ? ''
        : readString(entry.artist, `songs[${index}].artist`, NAME_MAX),
    ...source,
    lyrics_offset: readNumber(entry.lyrics_offset, `songs[${index}].lyrics_offset`, 0),
    duration: Math.max(0, readNumber(entry.duration, `songs[${index}].duration`, 0)),
  };
}

/**
 * Validate the bytes of an import file and hash them. Unknown top-level and
 * per-song fields are ignored on purpose: within a version, an older build
 * reading a file a newer one wrote should keep working.
 *
 * Async since N1a for the digest alone: the file is up to 20MB (the route's
 * cap), which is the one input in core big enough that hashing it in pure JS
 * would block the thread it runs on. Every host provides its own — the desktop
 * `node:crypto`, the phone whatever it has (N6's gate).
 */
export async function parseAndValidate(bytes: Uint8Array): Promise<ParsedImportFile> {
  const digest = await sha256BytesAsync(bytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch (err) {
    throw bad(`不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw bad('文件内容必须是一个 JSON 对象');
  }

  const file = parsed as Record<string, unknown>;
  if (file.format !== PLAYLIST_EXPORT_FORMAT) {
    throw bad(`不是 lark 歌单文件（format 应为 "${PLAYLIST_EXPORT_FORMAT}"）`);
  }
  // Version first, so a future file reports "upgrade lark" rather than a pile
  // of field-level complaints about a shape this build never understood.
  if (file.version !== PLAYLIST_EXPORT_VERSION) {
    throw new UnsupportedFormatVersionError(file.version, PLAYLIST_EXPORT_VERSION);
  }

  const playlist = file.playlist;
  if (typeof playlist !== 'object' || playlist === null || Array.isArray(playlist)) {
    throw bad('playlist 必须是对象');
  }
  const playlistName = readString(
    (playlist as Record<string, unknown>).name,
    'playlist.name',
    NAME_MAX,
  );
  if (playlistName === '') throw bad('playlist.name 不能为空');

  const rawSongs = file.songs;
  if (!Array.isArray(rawSongs)) throw bad('songs 必须是数组');
  if (rawSongs.length > IMPORT_SONGS_MAX) {
    throw bad(`一个文件最多 ${IMPORT_SONGS_MAX} 首歌（当前 ${rawSongs.length}）`);
  }

  return {
    digest,
    playlist_name: playlistName,
    entries: rawSongs.map(readEntry),
  };
}

// ─── Matching ──────────────────────────────────────────

export type ImportMatch =
  /** `(provider, key)` already in the library. */
  | { kind: 'library'; song_id: string }
  /** Same key as an earlier entry in this file; resolves to whatever it became. */
  | { kind: 'file'; index: number }
  /** A new song. `candidates` non-empty makes it a suspect (R12). */
  | { kind: 'new'; candidates: ImportCandidate[] };

/** Library songs with this exact name+artist, oldest first, ties broken by id. */
function candidatesFor(db: PortableDrizzle, entry: ImportEntry): ImportCandidate[] {
  return (
    db
      .select({ id: songs.id, name: songs.name, artist: songs.artist })
      .from(songs)
      .where(and(eq(songs.name, entry.name), eq(songs.artist, entry.artist)))
      .orderBy(songs.created_at, songs.id)
      .all()
      // `canonical`: an import preview cannot run while a migration is pending
      // — the daemon's routes are shut and the CLI refuses direct writes.
      .map((row) => ({
        ...row,
        has_file: songFileInfo(row.id, { audioMode: 'canonical' }).has_file,
      }))
  );
}

export function computeMatches(
  db: PortableDrizzle,
  entries: readonly ImportEntry[],
): ImportMatch[] {
  /** First entry index that claimed each `(provider, key)` in this file. */
  const claimed = new Map<string, number>();
  const matches: ImportMatch[] = [];

  for (const [index, entry] of entries.entries()) {
    const { source_provider: provider, source_key: key } = entry;
    if (provider === null || key === null) {
      matches.push({ kind: 'new', candidates: candidatesFor(db, entry) });
      continue;
    }
    // `\u0000` as an escape, not a literal NUL byte: a source file with one
    // in it reads as BINARY to grep / rg, which silently skip it.
    const keyId = `${provider}\u0000${key}`;
    const owner = claimed.get(keyId);
    if (owner !== undefined) {
      matches.push({ kind: 'file', index: owner });
      continue;
    }
    claimed.set(keyId, index);
    const hit = findSongByKey(db, provider, key);
    matches.push(
      hit === undefined
        ? { kind: 'new', candidates: candidatesFor(db, entry) }
        : { kind: 'library', song_id: hit.id },
    );
  }
  return matches;
}

/** The preview payload, minus nothing — the route only adds the envelope. */
export function previewImport(
  db: PortableDrizzle,
  file: ParsedImportFile,
): PlaylistImportPreviewData {
  const matches = computeMatches(db, file.entries);
  const suspects: ImportSuspect[] = [];
  let reuseCount = 0;

  matches.forEach((match, index) => {
    if (match.kind !== 'new') {
      reuseCount++;
      return;
    }
    if (match.candidates.length === 0) return;
    const entry = file.entries[index];
    suspects.push({
      index,
      name: entry.name,
      artist: entry.artist,
      candidates: match.candidates,
    });
  });

  return {
    digest: file.digest,
    total: file.entries.length,
    reuse_count: reuseCount,
    // Suspects are counted as new: importing them as new songs is the default
    // and the UI lists them separately anyway (M5-13).
    new_count: file.entries.length - reuseCount,
    playlist_name: file.playlist_name,
    suspects,
  };
}

// ─── Import ────────────────────────────────────────────

export type ImportTarget =
  /** Into the library only — no membership rows (the API's virtual `all`). */
  { kind: 'library' } | { kind: 'playlist'; playlistId: string } | { kind: 'new'; name: string };

export interface ImportInput {
  entries: readonly ImportEntry[];
  target: ImportTarget;
  /** Entries the user chose to merge into an existing song instead. */
  reuse?: readonly { index: number; song_id: string }[];
}

/**
 * Import every entry, or none (R27). Assumes the caller's transaction; the
 * `importPlaylist` wrapper opens one.
 */
export function importPlaylistInTx(store: PortableDb, input: ImportInput): PlaylistImportData {
  const { drizzle: db } = store;
  const { entries, target } = input;
  // Recomputed here, not taken from the preview: the library may have changed,
  // and only what is true inside this transaction may drive writes.
  const matches = computeMatches(db, entries);

  const chosen = new Map<number, string>();
  for (const item of input.reuse ?? []) {
    const match = matches[item.index] as ImportMatch | undefined;
    if (match === undefined) {
      throw new InvalidReuseError(`reuse 指向不存在的条目 #${item.index}`);
    }
    if (match.kind !== 'new') {
      throw new InvalidReuseError(`条目 #${item.index} 已按来源标识匹配到库中歌曲，不能再指定复用`);
    }
    if (!match.candidates.some((candidate) => candidate.id === item.song_id)) {
      throw new InvalidReuseError(`条目 #${item.index} 的复用目标已不是候选歌曲，请重新预览`);
    }
    chosen.set(item.index, item.song_id);
  }

  const playlistId =
    target.kind === 'new'
      ? createPlaylistInTx(store, target.name).id
      : target.kind === 'playlist'
        ? target.playlistId
        : null;

  const resolved: string[] = [];
  let created = 0;
  let reused = 0;

  entries.forEach((entry, index) => {
    const match = matches[index];
    if (match.kind === 'file') {
      // The owner is always an earlier index, so it is already resolved.
      resolved.push(resolved[match.index]);
      reused++;
      return;
    }
    if (match.kind === 'library') {
      resolved.push(match.song_id);
      reused++;
      return;
    }
    const merge = chosen.get(index);
    if (merge !== undefined) {
      resolved.push(merge);
      reused++;
      return;
    }
    // No file yet: it is fetched on demand when the song is played (§5.3).
    const song = createSongInTx(store, {
      name: entry.name,
      artist: entry.artist,
      source_url: entry.source_url,
      source_provider: entry.source_provider,
      source_key: entry.source_key,
      lyrics_offset: entry.lyrics_offset,
      duration: entry.duration,
    });
    resolved.push(song.id);
    created++;
  });

  const added = playlistId === null ? 0 : addSongsToPlaylistInTx(store, playlistId, resolved);
  return { playlist_id: playlistId, total: entries.length, created, reused, added };
}

export function importPlaylist(store: PortableDb, input: ImportInput): PlaylistImportData {
  return store.sqlite.transaction(() => importPlaylistInTx(store, input)).immediate();
}
