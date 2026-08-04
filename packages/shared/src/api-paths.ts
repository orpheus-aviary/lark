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
  events: '/events',
  songs: '/songs',
  playlists: '/playlists',
  config: '/config',
  playerStatus: '/player/status',
  playerReport: '/player/report',
  playerAck: '/player/ack',
  guiRegister: '/gui/register',
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
  playerCommand: (command: string) => `/player/${command}`,
} as const;
