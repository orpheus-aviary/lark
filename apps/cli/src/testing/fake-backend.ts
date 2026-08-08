// A recording Backend for command tests.
//
// Commands are tested against this rather than against a live daemon: what
// matters is which calls a command makes, in what order, and what it prints —
// the HTTP mapping itself is one thin file and is covered where it lives.

import type {
  ApiResponse,
  CacheEvictResultData,
  CacheStatusData,
  DownloadBatchData,
  DownloadBatchesData,
  DownloadTaskData,
  DownloadTasksData,
  FetchListData,
  ParseResultData,
  ParsedItem,
  PlayerStatusResponse,
  PlaylistData,
  PlaylistExportData,
  PlaylistImportData,
  PlaylistImportPreviewData,
  RecognizeUrlData,
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

  // Download (T4).
  parse?: ParseResultData;
  accepted?: { task_id: string };
  fetchList?: FetchListData;
  batches?: DownloadBatchesData;
  recognize?: RecognizeUrlData;

  // Player (T5). `playerStatus` is also what the GUI-online poll reads, so a
  // test scripts a GUI coming up by handing back a sequence of these.
  playerStatus?: PlayerStatusResponse;
  playerStatuses?: PlayerStatusResponse[];
  /**
   * One snapshot per `downloadTasks()` call; the last one repeats forever.
   * That is how a `--wait` test scripts "queued → running → succeeded" without
   * a clock.
   */
  taskSnapshots?: DownloadTasksData[];
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

export function task(overrides: Partial<DownloadTaskData> = {}): DownloadTaskData {
  return {
    id: 'task-1',
    kind: 'download',
    state: 'queued',
    stage: null,
    revision: 1,
    input: { type: 'url', url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    song_id: null,
    playlist_ids: [],
    failed_playlist_ids: [],
    created_at: 1,
    started_at: null,
    finished_at: null,
    error_code: null,
    error_message: null,
    result: null,
    ...overrides,
  };
}

export function batch(overrides: Partial<DownloadBatchData> = {}): DownloadBatchData {
  return {
    id: 'batch-1',
    target: { kind: 'all' },
    total: 1,
    items: [{ index: 0, task_id: 'task-1', final: null }],
    created_at: 1,
    ...overrides,
  };
}

/**
 * What the daemon's `/download/parse` would say about one line.
 *
 * One item per line, IN ORDER — the property the command layer relies on to
 * turn "item 4 is a favourites link" back into "line 7 of your file". The
 * recognition itself is deliberately crude (`BV…` is a video, `fav:<id>` a
 * folder, `col:<mid>:<season>` a collection, everything else a keyword): tests
 * that need real URL parsing belong to core's parser, and a fake that is
 * STRICTER than the daemon invents failures that cannot happen (M6 T2).
 */
function parsedItem(line: string): ParsedItem {
  if (line.startsWith('BV')) {
    return { kind: 'video', bvid: line, page: null, url: `https://www.bilibili.com/video/${line}` };
  }
  if (line.startsWith('fav:')) {
    return { kind: 'favorites', media_id: line.slice('fav:'.length), url: line };
  }
  if (line.startsWith('col:')) {
    const [mid = '', seasonId = ''] = line.slice('col:'.length).split(':');
    return { kind: 'collection', mid, season_id: seasonId, url: line };
  }
  return { kind: 'keyword', query: line };
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

    parseInput: (input) =>
      record('parseInput', [input], data.parse ?? { items: input.split('\n').map(parsedItem) }),
    downloadSong: (request) =>
      record('downloadSong', [request], data.accepted ?? { task_id: 'task-1' }),
    fetchList: (request) => record('fetchList', [request], data.fetchList as FetchListData),
    downloadBatch: (groups) =>
      record('downloadBatch', [groups], data.batches ?? { batches: [batch()] }),
    downloadTasks: () => {
      calls.push({ method: 'downloadTasks', args: [] });
      const scripted = data.taskSnapshots ?? [];
      // The last snapshot repeats: a poll loop asks until it sees a terminal
      // state, and a script that ran out would otherwise change the answer.
      const snapshot = scripted.length > 1 ? (scripted.shift() as DownloadTasksData) : scripted[0];
      return Promise.resolve({ success: true, data: snapshot ?? { tasks: [], batches: [] } });
    },
    playerStatus: () => {
      calls.push({ method: 'playerStatus', args: [] });
      // Scripted answers, last one repeating — the same shape `taskSnapshots`
      // uses, for the same reason: a poll loop must see a stable final answer.
      const scripted = data.playerStatuses ?? [];
      const next = scripted.length > 1 ? (scripted.shift() as PlayerStatusResponse) : scripted[0];
      const answer = next ??
        data.playerStatus ?? { gui_online: false, player: null, reported_at: null };
      return Promise.resolve({ success: true, data: answer });
    },
    playerCommand: (command, body) =>
      record('playerCommand', [command, body], { request_id: 'request-1' }),

    redownloadSong: (id) => record('redownloadSong', [id], data.accepted ?? { task_id: 'task-1' }),
    recognizeUrl: (id, url) =>
      record('recognizeUrl', [id, url], data.recognize as RecognizeUrlData),
    downloadLyrics: (id) => record('downloadLyrics', [id], data.accepted ?? { task_id: 'task-1' }),
    deleteLyrics: (id) => record('deleteLyrics', [id], { id }),

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
