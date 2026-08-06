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
