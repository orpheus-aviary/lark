// The daemon's HTTP surface as data: every caller (daemon routes, CLI, GUI)
// composes requests from these constants instead of re-typing path literals, so
// a rename breaks the build rather than a runtime call.
//
// Kept dependency-free (no fetch / DOM) so it can be imported through the
// `@lark/shared/api-paths` subpath without pulling in the HTTP client.

/** Loopback port owned by the lark daemon. The `471xx` band belongs to lark. */
export const DEFAULT_DAEMON_PORT = 47100;

/** Base URL of a daemon listening on the default loopback port. */
export function defaultDaemonBaseUrl(port: number = DEFAULT_DAEMON_PORT): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Compatibility gate for the local HTTP protocol (M4-2). A front-end refuses
 * to talk to a running daemon whose `local_api_version` differs — the package
 * version cannot carry that signal (it sits at 0.1.0 across protocol changes).
 * Bump on any breaking change to the daemon's local API.
 *
 * Lives here, in the wire contract, rather than in `@lark/daemon`: since M6
 * the CLI compares it too, and the CLI must not depend on the daemon package
 * (M6-21).
 *
 *   2 (M5): `[theme]` in the config plus the M5 routes (/cache, playlist
 *     import/export, ensure-file).
 *   3 (M6): `GET /status` carries `nest_fingerprint` + `local_api_version`,
 *     which is what identity resolution is built on — an M5 daemon answers
 *     without them and cannot be adopted.
 *   4 (M7): `GET /api/capabilities` carries `media_tools`, and download /
 *     import answer `MEDIA_TOOLS_UNAVAILABLE` instead of folding a missing
 *     ffmpeg into a per-file failure. A client written against 4 renders a
 *     state a 3 daemon never reports.
 */
export const LOCAL_API_VERSION = 4;

/** Static daemon route paths. Extended milestone by milestone. */
export const API_PATHS = {
  status: '/status',
  capabilities: '/api/capabilities',
  instance: '/api/instance',
  events: '/events',
  songs: '/songs',
  playlists: '/playlists',
  config: '/config',
  playerStatus: '/player/status',
  playerReport: '/player/report',
  playerAck: '/player/ack',
  guiRegister: '/gui/register',

  // Download pipeline (M3). `/download/parse` never enqueues — it is the
  // preview half of the paste box; everything else returns task ids.
  downloadSong: '/download/song',
  downloadParse: '/download/parse',
  downloadBatch: '/download/batch',
  downloadFetchList: '/download/fetch-list',
  downloadCancel: '/download/cancel',
  downloadTasks: '/download/tasks',
  songImport: '/songs/import',

  // Cache (M5). `status` is a read; `evict` runs the LRU drain and answers
  // with what it freed plus the recomputed status.
  cacheStatus: '/cache/status',
  cacheEvict: '/cache/evict',

  // Playlist transfer (M5). Two-step import: preview reads and validates the
  // file, the commit re-reads it and refuses if it changed in between.
  playlistImportPreview: '/playlists/import-preview',
  playlistImport: '/playlists/import',
} as const;

/** Parameterised route paths. Ids are UUID v4 (or the literal `all`, R3). */
export const apiPath = {
  song: (id: string) => `/songs/${id}`,
  songPin: (id: string) => `/songs/${id}/pin`,
  audio: (id: string) => `/audio/${id}`,
  lyrics: (id: string) => `/lyrics/${id}`,
  playlist: (id: string) => `/playlists/${id}`,
  playlistSongs: (id: string) => `/playlists/${id}/songs`,
  playlistSong: (id: string, songId: string) => `/playlists/${id}/songs/${songId}`,
  playlistReorder: (id: string) => `/playlists/${id}/reorder`,
  /** Export a playlist (or `all`) as an interchange file (M5-12). */
  playlistExport: (id: string) => `/playlists/${id}/export`,
  playerCommand: (command: string) => `/player/${command}`,

  // Download pipeline (M3).
  downloadLyrics: (id: string) => `/download/lyrics/${id}`,
  songRecognizeUrl: (id: string) => `/songs/${id}/recognize-url`,
  songRedownload: (id: string) => `/songs/${id}/redownload`,
  /** Fetch the audio only if it is missing (M5-8). */
  songEnsureFile: (id: string) => `/songs/${id}/ensure-file`,
} as const;
