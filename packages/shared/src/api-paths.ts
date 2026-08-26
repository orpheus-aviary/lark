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
 *   5 (v0.2): the `/sync/*` and `/conflicts/*` surface, and the three sync SSE
 *     events. A 4 daemon answers 404 to every one of them, which a badge
 *     cannot tell from "sync is off" — hence a version, not feature detection.
 *   6 (0.3.0): m4a is the library's one format, and the download surface says
 *     more about itself. `GET /api/capabilities` carries `audio_format`,
 *     `import_formats` and `llm_available`; `POST /download/song` REQUIRES
 *     `naming_mode` on a link and a batch video item requires `naming`; the
 *     task snapshot and `download:status` carry byte progress; there is a
 *     `naming` stage and a `POST /download/cancel-all`; a task snapshot names
 *     the song it is about (`title` / `artist`) instead of leaving a client to
 *     show the raw link; and `/api/audio-migration` exists at all. A 5 daemon rejects the naming fields as
 *     unknown body keys — a client written against 6 cannot download through
 *     one, which is exactly what a version gate is for.
 */
/*
 *   7 → the workspace surface (N7). One device can hold several libraries, so
 *     there is a `GET /workspaces` and a `POST /workspaces/switch`, and
 *     `POST /sync/login` takes `workspace_origin` and answers with
 *     `local_workspace_id` / `local_workspace_created` / `restart_required`.
 *     A 6 daemon rejects `workspace_origin` as an unknown body key, so a
 *     client written against 7 cannot ask one to put an account's library
 *     anywhere but the file it is already serving.
 */
export const LOCAL_API_VERSION = 7;

/** Static daemon route paths. Extended milestone by milestone. */
export const API_PATHS = {
  status: '/status',
  capabilities: '/api/capabilities',
  instance: '/api/instance',
  events: '/events',

  // The one-time mp3 → m4a migration (0.3.0). Reachable while the library is
  // NOT being served — that is the point of them — and afterwards, because the
  // ledger stays as the report of what happened to each file.
  audioMigration: '/api/audio-migration',
  audioMigrationRetry: '/api/audio-migration/retry',
  audioMigrationBackupClear: '/api/audio-migration/backup/clear',
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
  downloadCancelAll: '/download/cancel-all',
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

  // skybridge sync (v0.2). `/sync/status` is the only one a front-end polls;
  // everything else is an action. The file-op trio exists because a failed
  // file effect needs a way OUT of the daemon and back to a person.
  syncLogin: '/sync/login',
  syncLogout: '/sync/logout',
  syncRun: '/sync/run',
  syncStatus: '/sync/status',
  syncDevices: '/sync/devices',
  syncRevokeDevice: '/sync/revoke-device',
  syncFileOps: '/sync/file-ops',
  syncFileOpsRetry: '/sync/file-ops/retry',
  syncFileOpsDiscard: '/sync/file-ops/discard',

  // Workspaces (N7). One device, several libraries: `local` where it has
  // always been, and one per account under `libraries/<id>/`. Switching writes
  // one line and takes effect at the next launch — which is what makes it
  // safe, not a limitation (`core/workspace-switch.ts`).
  workspaces: '/workspaces',
  workspacesSwitch: '/workspaces/switch',

  // Conflicts (v0.2, D4). Records, not merges: LWW already decided, and these
  // let the user put their own version back.
  conflicts: '/conflicts',
  conflictsCount: '/conflicts/count',
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

  // Conflicts (v0.2). The id is the conflict's, not the song's.
  conflict: (id: string) => `/conflicts/${id}`,
  conflictResolve: (id: string) => `/conflicts/${id}/resolve`,
} as const;
