// A recording Backend for command tests.
//
// Commands are tested against this rather than against a live daemon: what
// matters is which calls a command makes, in what order, and what it prints —
// the HTTP mapping itself is one thin file and is covered where it lives.

import type {
  ApiResponse,
  CacheEvictResultData,
  CacheStatusData,
  PlaylistData,
  PlaylistExportData,
  PlaylistImportData,
  PlaylistImportPreviewData,
  SongData,
  StatusData,
} from '@lark/shared';
import type { Backend, ImportCommitRequest, SongListQuery } from '../backend/types.js';
import type { CommandContext, GlobalFlags } from '../context.js';
import { IdentityHandle } from '../lib/identity.js';
import { type Streams, captureStreams } from '../lib/output.js';

export interface CallRecord {
  method: string;
  args: unknown[];
}

export interface FakeBackendData {
  songs?: SongData[];
  playlists?: PlaylistData[];
  playlistSongs?: SongData[];
  exportData?: PlaylistExportData;
  preview?: PlaylistImportPreviewData;
  importResult?: PlaylistImportData;
  status?: StatusData;
  cacheStatus?: CacheStatusData;
  cacheEvict?: CacheEvictResultData;
}

export interface FakeBackend extends Backend {
  readonly calls: CallRecord[];
  /** Method names in call order — the usual assertion. */
  names(): string[];
  /** Arguments of the first call to `method`. */
  argsOf(method: string): unknown[] | undefined;
}

export function song(overrides: Partial<SongData> = {}): SongData {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    name: '歌',
    artist: '歌手',
    source_url: null,
    source_provider: null,
    source_key: null,
    file_origin: 'downloaded',
    lyrics_offset: 0,
    duration: 100,
    pinned: false,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

export function playlist(overrides: Partial<PlaylistData> = {}): PlaylistData {
  return {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    name: '歌单',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

export function createFakeBackend(data: FakeBackendData = {}): FakeBackend {
  const calls: CallRecord[] = [];
  const record = <T>(method: string, args: unknown[], data: T): Promise<ApiResponse<T>> => {
    calls.push({ method, args });
    return Promise.resolve({ success: true, data });
  };

  const songs = data.songs ?? [];
  const playlists = data.playlists ?? [];

  return {
    calls,
    names: () => calls.map((call) => call.method),
    argsOf: (method) => calls.find((call) => call.method === method)?.args,

    status: () => record('status', [], data.status as StatusData),

    listSongs: (query: SongListQuery) => {
      calls.push({ method: 'listSongs', args: [query] });
      // Mirrors the daemon's filter: `name LIKE %s% OR artist LIKE %s%`, and
      // SQLite's LIKE is case-insensitive for ASCII. A stricter fake here
      // would fail name resolution that works against a real daemon.
      const needle = query.search?.toLowerCase();
      const filtered =
        needle === undefined
          ? songs
          : songs.filter(
              (s) =>
                s.name.toLowerCase().includes(needle) || s.artist.toLowerCase().includes(needle),
            );
      return Promise.resolve({ success: true, data: filtered, total: filtered.length });
    },
    getSong: (id) => record('getSong', [id], songs.find((s) => s.id === id) ?? song({ id })),
    updateSong: (id, patch) => record('updateSong', [id, patch], song({ id, ...patch })),
    deleteSong: (id) => record('deleteSong', [id], { id }),
    pinSong: (id, pinned) => record('pinSong', [id, pinned], song({ id, pinned })),

    listPlaylists: () => record('listPlaylists', [], playlists),
    createPlaylist: (name) => record('createPlaylist', [name], playlist({ name })),
    renamePlaylist: (id, name) => record('renamePlaylist', [id, name], playlist({ id, name })),
    deletePlaylist: (id) => record('deletePlaylist', [id], { id }),
    listPlaylistSongs: (id) => record('listPlaylistSongs', [id], data.playlistSongs ?? []),
    addPlaylistSongs: (id, songIds) =>
      record('addPlaylistSongs', [id, songIds], { added: songIds.length }),
    removePlaylistSong: (id, songId) =>
      record('removePlaylistSong', [id, songId], { playlist_id: id, song_id: songId }),
    reorderPlaylist: (id, move) => record('reorderPlaylist', [id, move], { playlist_id: id }),

    cacheStatus: () => record('cacheStatus', [], data.cacheStatus as CacheStatusData),
    cacheEvict: () => record('cacheEvict', [], data.cacheEvict as CacheEvictResultData),

    exportPlaylist: (id) => record('exportPlaylist', [id], data.exportData as PlaylistExportData),
    importPreview: (filePath) =>
      record('importPreview', [filePath], data.preview as PlaylistImportPreviewData),
    importPlaylist: (request: ImportCommitRequest) =>
      record('importPlaylist', [request], data.importResult as PlaylistImportData),
  };
}

export interface FakeContext extends CommandContext {
  backend: FakeBackend;
  streams: Streams & { stdout: string[]; stderr: string[] };
}

/** A CommandContext over the fake backend, with both streams captured. */
export function fakeContext(
  data: FakeBackendData = {},
  flags: Partial<GlobalFlags> = {},
): FakeContext {
  const streams = captureStreams();
  return {
    backend: createFakeBackend(data),
    streams,
    flags: { json: false, direct: false, yes: true, ...flags },
    identity: new IdentityHandle(),
  };
}
