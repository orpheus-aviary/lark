import {
  API_PATHS,
  type ApiResponse,
  type PlaylistData,
  type PlaylistExportData,
  type PlaylistImportData,
  type PlaylistImportPreviewData,
  type PlaylistReorderRequest,
  type PlaylistSongsAddedData,
  type SongData,
  type StatusData,
  type UpdateSongRequest,
  apiPath,
  configureTransport,
  defaultDaemonBaseUrl,
  request,
} from '@lark/shared';
import { daemonAuthHeaders } from '../lib/auth.js';
import { CliError } from '../lib/errors.js';
import type { Backend, ImportCommitRequest, SongListQuery } from './types.js';

/**
 * Talk to a running daemon over HTTP — the default backend.
 *
 * Auth is wired ONCE, here, as a callback: the transport asks for headers per
 * request, so `daemonAuthHeaders()` re-reads the token file every time and a
 * daemon that rotated its token mid-command is followed rather than fought
 * (R29).
 */
export function createHttpBackend(baseUrl: string = defaultDaemonBaseUrl()): Backend {
  configureTransport({ baseUrl: () => baseUrl, getAuthHeaders: () => daemonAuthHeaders() });

  const get = <T>(path: string): Promise<ApiResponse<T>> => call(() => request<T>('GET', path));
  const send = <T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
    call(() => request<T>(method, path, body));

  return {
    status: () => get<StatusData>(API_PATHS.status),

    listSongs: (query: SongListQuery) => get<SongData[]>(`${API_PATHS.songs}${queryString(query)}`),
    getSong: (id) => get<SongData>(apiPath.song(id)),
    updateSong: (id, patch: UpdateSongRequest) => send<SongData>('PUT', apiPath.song(id), patch),
    deleteSong: (id) => send<{ id: string }>('DELETE', apiPath.song(id)),
    pinSong: (id, pinned) => send<SongData>('PUT', apiPath.songPin(id), { pinned }),

    listPlaylists: () => get<PlaylistData[]>(API_PATHS.playlists),
    createPlaylist: (name) => send<PlaylistData>('POST', API_PATHS.playlists, { name }),
    renamePlaylist: (id, name) => send<PlaylistData>('PUT', apiPath.playlist(id), { name }),
    deletePlaylist: (id) => send<{ id: string }>('DELETE', apiPath.playlist(id)),
    listPlaylistSongs: (id) => get<SongData[]>(apiPath.playlistSongs(id)),
    addPlaylistSongs: (id, songIds) =>
      send<PlaylistSongsAddedData>('POST', apiPath.playlistSongs(id), { song_ids: songIds }),
    removePlaylistSong: (id, songId) =>
      send<{ playlist_id: string; song_id: string }>('DELETE', apiPath.playlistSong(id, songId)),
    reorderPlaylist: (id, move: PlaylistReorderRequest) =>
      send<{ playlist_id: string }>('POST', apiPath.playlistReorder(id), move),

    exportPlaylist: (id) => get<PlaylistExportData>(apiPath.playlistExport(id)),
    importPreview: (filePath) =>
      send<PlaylistImportPreviewData>('POST', API_PATHS.playlistImportPreview, {
        file_path: filePath,
      }),
    importPlaylist: (body: ImportCommitRequest) =>
      send<PlaylistImportData>('POST', API_PATHS.playlistImport, body),
  };
}

/** `?a=1&b=2`, or '' — absent fields are absent, never `?search=undefined`. */
function queryString(query: SongListQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

/**
 * Turn a connection-level failure into the state it actually describes.
 *
 * The transport throws the raw fetch error when nothing is listening; that is
 * `DAEMON_UNAVAILABLE` (exit 4, "start one"), not a generic failure. Response
 * errors already arrive as `ApiError` and are translated by `toCliError`.
 */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TypeError) {
      throw new CliError(
        'DAEMON_UNAVAILABLE',
        `连接不上 daemon（${defaultDaemonBaseUrl()}）：${err.message}`,
      );
    }
    throw err;
  }
}
