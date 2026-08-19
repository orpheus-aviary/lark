// The library, as one surface every front end shares (N1g, subplan §2.6).
//
// Below this file are core's write paths: `listSongs`, `updateSong`,
// `addSongsToPlaylist` and friends, each doing exactly one thing to the
// database. Above it are three front ends that all need the same handful of
// decisions made the same way — is this a valid id, is `all` writable, is
// `' 稻香 '` the same name as `'稻香'`, how many ids may one call carry — and
// until now each of them made those decisions itself.
//
// They agreed until they didn't. `--direct` checked a name's LENGTH but never
// trimmed it, so a blank name was a 400 over HTTP and a row in process; the id
// gate lived in the daemon's route layer, so `--direct` reported "not found"
// for a malformed id; the virtual `all` playlist was composed by the daemon,
// so listing playlists returned a different set depending on whether a daemon
// happened to be running (§7 F13, and the two M6 cases).
//
// What is HERE is what the library itself asserts. What stays with each front
// end is its own vocabulary:
//
//   the daemon keeps request SHAPE (is this JSON an object, is `limit` an
//     integer, is the path parameter there) and the `ApiResponse` envelope;
//   the CLI keeps `CliError` and its exit codes;
//   both translate `LibraryInputError` into the code they have always sent —
//     which is why that error carries `field` and `reason` rather than only a
//     sentence.

import {
  PLAYLIST_NAME_MAX,
  type PlaylistData,
  type PlaylistExportData,
  type PlaylistImportPreviewData,
  SONG_ARTIST_MAX,
  SONG_NAME_MAX,
  type SongData,
  VIRTUAL_ALL_PLAYLIST_ID,
  isUuidV4,
} from '@lark/shared';
import type { PortableDb } from '../db.js';
import { InvalidIdError, LibraryInputError, VirtualPlaylistError } from '../errors.js';
import {
  type CacheOptions,
  type CacheStatus,
  type EvictionOptions,
  type EvictionRun,
  cacheStatus,
  runEviction,
} from '../library/cache.js';
import { deleteLyrics } from '../library/lyrics.js';
import {
  type ReorderAnchors,
  addSongsToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  getPlaylistSongs,
  listPlaylists,
  removeSongFromPlaylist,
  renamePlaylist,
  reorderSong,
} from '../library/playlists.js';
import {
  type AudioMode,
  type ListSongsOptions,
  type ListSongsResult,
  type UpdateSongInput,
  deleteSong,
  getSong,
  listSongs,
  setPinned,
  songFileInfo,
  updateSong as updateSongRow,
} from '../library/songs.js';
import {
  type ExportSource,
  type ImportInput,
  type ParsedImportFile,
  buildExport,
  importPlaylist,
  parseAndValidate,
  previewImport,
} from '../library/transfer.js';
import type { FileContext } from '../ports/fs.js';
import type { FileEffectLike } from '../sync/file-ops.js';

/**
 * The ceilings, in one place.
 *
 * `name` and `artist` come from `@lark/shared` — the sync payload validator
 * screens the same fields arriving from another device and has to reject
 * exactly what a local edit rejects. The rest are this layer's: nothing below
 * it has a `search` or a page size.
 */
export const LIBRARY_LIMITS = {
  search: 200,
  limit: 1000,
  /** Ids per `addPlaylistSongs` call. */
  songIds: 1000,
} as const;

export interface ReorderMove {
  song_id: string;
  before_song_id?: string;
  after_song_id?: string;
}

export interface LibraryServiceDeps {
  db: PortableDb;
  files: FileContext;
  /** Executes the file removal a delete queues. */
  fileOps: FileEffectLike;
  /**
   * Which file name counts as this song's audio.
   *
   * Read ONCE by the caller, not per call: the mode only ever WIDENS (m4a, or
   * m4a and mp3), so a migration finishing mid-command cannot make an answer
   * wrong. The daemon is always `canonical` — business routes do not serve
   * while a conversion is pending — and the CLI's direct backend reads the
   * flag when it opens the library.
   */
  audioMode: AudioMode;
}

export interface LibraryService {
  // ── songs ──
  listSongs(options: ListSongsOptions): ListSongsResult;
  getSong(id: string): SongData;
  updateSong(id: string, patch: UpdateSongInput): SongData;
  deleteSong(id: string): Promise<void>;
  pinSong(id: string, pinned: boolean): SongData;
  /** `has_file` / `file_size` for a song the caller already has in hand. */
  enrich(song: SongData): SongData;

  // ── playlists ──
  /** The virtual `all` first, then the rows (R3/R24). */
  listPlaylists(): PlaylistData[];
  getPlaylist(id: string): PlaylistData;
  createPlaylist(name: string): PlaylistData;
  renamePlaylist(id: string, name: string): PlaylistData;
  deletePlaylist(id: string): void;
  listPlaylistSongs(id: string): SongData[];
  addPlaylistSongs(id: string, songIds: readonly string[]): number;
  removePlaylistSong(id: string, songId: string): void;
  reorderPlaylist(id: string, move: ReorderMove): void;

  // ── lyrics (a local file, written directly) ──
  deleteLyrics(id: string): Promise<boolean>;

  // ── transfer ──
  buildExport(source: ExportSource): PlaylistExportData;
  parseImportFile(bytes: Uint8Array): Promise<ParsedImportFile>;
  previewImport(file: ParsedImportFile): PlaylistImportPreviewData;
  importPlaylist(input: ImportInput): ImportResult;

  // ── cache ──
  cacheStatus(options: CacheOptions): CacheStatus;
  runEviction(options: EvictionOptions): Promise<EvictionRun>;
}

type ImportResult = ReturnType<typeof importPlaylist>;

/** Trim first, then require non-empty, then cap what is left (§7 F13). */
export function requiredName(value: string, max: number, what: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new LibraryInputError(what, 'required', `${label(what)}不能为空。`);
  return capped(trimmed, max, what);
}

/** Same rule, for a field that MAY be blank (a song's artist). */
export function optionalName(value: string, max: number, what: string): string {
  return capped(value.trim(), max, what);
}

function capped(value: string, max: number, what: string): string {
  if (value.length > max) {
    throw new LibraryInputError(what, 'too_long', `${label(what)}最长 ${max} 个字符。`, max);
  }
  return value;
}

/** What a person calls the field. Unknown fields fall back to their key. */
function label(field: string): string {
  const LABELS: Record<string, string> = {
    name: '名称',
    song_name: '歌名',
    artist: '歌手名',
    playlist_name: '歌单名',
    search: '搜索词',
    limit: '--limit',
    song_ids: '歌曲列表',
  };
  return LABELS[field] ?? field;
}

/** The id gate (R10). A malformed id is a caller mistake, not a missing row. */
export function assertLibraryId(id: string): string {
  if (!isUuidV4(id)) throw new InvalidIdError(id);
  return id;
}

export function createLibraryService(deps: LibraryServiceDeps): LibraryService {
  const { db: store, files, fileOps, audioMode } = deps;
  const { drizzle, sqlite } = store;

  const enrich = (song: SongData): SongData => ({
    ...song,
    ...songFileInfo(files, song.id, { audioMode }),
  });

  /** Readable ids also accept the virtual `all`. */
  const readableId = (id: string): string =>
    id === VIRTUAL_ALL_PLAYLIST_ID ? id : assertLibraryId(id);

  /** `all` is a view: readable, never writable. */
  const writableId = (id: string): string => {
    if (id === VIRTUAL_ALL_PLAYLIST_ID) throw new VirtualPlaylistError();
    return assertLibraryId(id);
  };

  return {
    enrich,

    listSongs(options) {
      const query: ListSongsOptions = { ...options };
      // Trimmed like the wire trims it: a search for `' 稻香 '` is a search for
      // `'稻香'`, and LIKE would not agree.
      if (query.search !== undefined) {
        query.search = capped(query.search.trim(), LIBRARY_LIMITS.search, 'search');
      }
      if (query.limit !== undefined && query.limit > LIBRARY_LIMITS.limit) {
        throw new LibraryInputError(
          'limit',
          'too_long',
          `--limit 最大 ${LIBRARY_LIMITS.limit}。`,
          LIBRARY_LIMITS.limit,
        );
      }
      const result = listSongs(drizzle, sqlite, query);
      return { songs: result.songs.map(enrich), total: result.total };
    },

    getSong(id) {
      return enrich(getSong(drizzle, sqlite, assertLibraryId(id)));
    },

    updateSong(id, patch) {
      const edit: UpdateSongInput = { ...patch };
      // The artist MAY be cleared; the name may not.
      if (edit.name !== undefined) edit.name = requiredName(edit.name, SONG_NAME_MAX, 'song_name');
      if (edit.artist !== undefined) {
        edit.artist = optionalName(edit.artist, SONG_ARTIST_MAX, 'artist');
      }
      return enrich(updateSongRow(store, assertLibraryId(id), edit));
    },

    async deleteSong(id) {
      await deleteSong(store, assertLibraryId(id), { fileOps });
    },

    pinSong(id, pinned) {
      const songId = assertLibraryId(id);
      setPinned(drizzle, sqlite, songId, pinned);
      return enrich(getSong(drizzle, sqlite, songId));
    },

    listPlaylists() {
      // `all` comes FIRST, and it is composed here rather than by whichever
      // front end happened to ask: a list that differs between them makes
      // every name-based reference resolve differently depending on whether a
      // daemon is running (an M6 case).
      const virtualAll: PlaylistData = {
        id: VIRTUAL_ALL_PLAYLIST_ID,
        name: VIRTUAL_ALL_PLAYLIST_ID,
        created_at: 0,
        updated_at: 0,
        // `limit: 0` fetches no rows but still reports the count.
        song_count: listSongs(drizzle, sqlite, { limit: 0 }).total,
      };
      return [virtualAll, ...listPlaylists(drizzle, sqlite)];
    },

    getPlaylist(id) {
      return getPlaylist(drizzle, sqlite, assertLibraryId(id));
    },

    createPlaylist(name) {
      return createPlaylist(store, requiredName(name, PLAYLIST_NAME_MAX, 'playlist_name'));
    },

    renamePlaylist(id, name) {
      return renamePlaylist(
        store,
        writableId(id),
        requiredName(name, PLAYLIST_NAME_MAX, 'playlist_name'),
      );
    },

    deletePlaylist(id) {
      deletePlaylist(store, writableId(id));
    },

    listPlaylistSongs(id) {
      // The virtual playlist is every song in creation order — the same list
      // the library view shows by default.
      const songs =
        id === VIRTUAL_ALL_PLAYLIST_ID
          ? listSongs(drizzle, sqlite, { sort: 'created_at', order: 'asc' }).songs
          : getPlaylistSongs(drizzle, sqlite, readableId(id));
      return songs.map(enrich);
    },

    addPlaylistSongs(id, songIds) {
      if (songIds.length > LIBRARY_LIMITS.songIds) {
        throw new LibraryInputError(
          'song_ids',
          'too_many',
          `一次最多添加 ${LIBRARY_LIMITS.songIds} 首。`,
          LIBRARY_LIMITS.songIds,
        );
      }
      return addSongsToPlaylist(store, writableId(id), songIds.map(assertLibraryId));
    },

    removePlaylistSong(id, songId) {
      removeSongFromPlaylist(store, writableId(id), assertLibraryId(songId));
    },

    reorderPlaylist(id, move) {
      const anchors: ReorderAnchors = {};
      if (move.before_song_id !== undefined) anchors.before_song_id = move.before_song_id;
      if (move.after_song_id !== undefined) anchors.after_song_id = move.after_song_id;
      reorderSong(store, writableId(id), assertLibraryId(move.song_id), anchors);
    },

    deleteLyrics(id) {
      return deleteLyrics(store, files, assertLibraryId(id));
    },

    buildExport(source) {
      return buildExport(drizzle, source);
    },

    parseImportFile(bytes) {
      return parseAndValidate(bytes);
    },

    previewImport(file) {
      return previewImport(drizzle, files, file);
    },

    importPlaylist(input) {
      return importPlaylist(store, files, input);
    },

    cacheStatus(options) {
      return cacheStatus(files, drizzle, options);
    },

    runEviction(options) {
      return runEviction(files, drizzle, options);
    },
  };
}
