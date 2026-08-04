// Wire types shared by every lark front-end (Electron renderer, CLI, future
// mobile). snake_case fields mirror the daemon's HTTP payloads verbatim;
// interface names are PascalCase. Kept free of any Node / Electron / DOM-host
// concept so the same definitions compile everywhere.

/**
 * The uniform response envelope. Exceptions (documented in the master plan
 * §R15): `GET /audio/:id` (binary + Range), `GET /lyrics/:id` (text/plain),
 * `GET /events` (SSE).
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error_code?: string;
  details?: Record<string, unknown>;
  total?: number;
}

/** Origin of the CURRENT on-disk file (R1): downloads are evictable once
 * re-downloadable; imports are user assets and never auto-evicted. */
export type FileOrigin = 'downloaded' | 'imported';

/**
 * Song wire shape. Sync-internal fields (device_id, lww_counter) and local
 * behavior data (last_accessed_at) never cross the wire. `has_file` /
 * `file_size` are optional disk-probe enrichments — not stored in the DB.
 * rank never appears on the wire either: reorder is expressed via neighbor
 * song ids (R7).
 */
export interface SongData {
  id: string;
  name: string;
  artist: string;
  source_url: string | null;
  source_provider: string | null;
  source_key: string | null;
  file_origin: FileOrigin;
  lyrics_offset: number;
  duration: number;
  pinned: boolean;
  created_at: number;
  updated_at: number;
  has_file?: boolean;
  file_size?: number;
}

/**
 * Song list ordering domain (M2-16). Runtime constants, not just types: the
 * daemon validates `?sort=`/`?order=` against these exact arrays, so a query
 * the GUI can build is a query the daemon accepts — and a typo like
 * `?srot=name` is a 400 rather than a silent fallback to the default.
 */
export const SONG_SORT_FIELDS = ['name', 'artist', 'created_at'] as const;
export type SongSortField = (typeof SONG_SORT_FIELDS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/** Playlist wire shape. `song_count` is filled by list queries. */
export interface PlaylistData {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  song_count?: number;
}

/** The virtual all-songs playlist id (R3/R24) — read-only, never a DB row. */
export const VIRTUAL_ALL_PLAYLIST_ID = 'all';

/** `GET /status` payload — the daemon liveness probe (permanently unauthed). */
export interface StatusData {
  status: 'ok';
  /** Daemon process id, used by the GUI to adopt / replace a running daemon. */
  pid: number;
  /** Seconds since the daemon process started. */
  uptime: number;
  /** Daemon package version. */
  version: string;
}

/** `GET /api/capabilities` — self-description for agent discovery. */
export interface CapabilityEndpoint {
  method: string;
  path: string;
  description: string;
}

export interface CapabilitiesData {
  name: 'lark';
  version: string;
  endpoints: CapabilityEndpoint[];
}

// ─── Player channel (R11) ──────────────────────────────
//
// The renderer owns playback; the daemon only mirrors what the GUI reports
// and relays commands to it. Nothing here is persisted (M2-11).

/** Play modes, Go-version parity. Runtime constant so the daemon can validate. */
export const PLAY_MODES = ['sequential', 'repeat-one', 'repeat-all', 'shuffle'] as const;
export type PlayMode = (typeof PLAY_MODES)[number];

/** Minimal song identity carried in a player report. */
export interface PlayerSongInfo {
  id: string;
  name: string;
  artist: string;
}

/** `POST /player/report` body AND the mirror inside `GET /player/status`. */
export interface PlayerStatusData {
  current_song: PlayerSongInfo | null;
  is_playing: boolean;
  current_time: number;
  duration: number;
  play_mode: PlayMode;
  /** Playlist the GUI is playing from — `'all'` for the virtual list. */
  playlist_id: string | null;
}

/** `GET /player/status` payload. `player` is null until a GUI has reported. */
export interface PlayerStatusResponse {
  /** True while a registered GUI holds the active SSE channel. */
  gui_online: boolean;
  player: PlayerStatusData | null;
  reported_at: number | null;
}

/**
 * Player commands, frozen wire-side (M2-11). The command name is the URL
 * (`POST /player/<command>`) and the body carries exactly the fields below;
 * the same shape rides the `player:command` SSE event with a `request_id`
 * the GUI echoes back through `POST /player/ack`.
 */
export const PLAYER_COMMANDS = [
  'play',
  'play-playlist',
  'switch-playlist',
  'pause',
  'resume',
  'next',
  'prev',
  'seek',
  'mode',
] as const;
export type PlayerCommandName = (typeof PLAYER_COMMANDS)[number];

export type PlayerCommand =
  | { command: 'play'; song_id: string }
  | { command: 'play-playlist'; playlist_id: string; song_id?: string }
  | { command: 'switch-playlist'; playlist_id: string }
  | { command: 'pause' }
  | { command: 'resume' }
  | { command: 'next' }
  | { command: 'prev' }
  | { command: 'seek'; position: number }
  | { command: 'mode'; mode: PlayMode };

/** `POST /player/ack` body — late / unknown request_ids are ignored (200). */
export interface AckRequest {
  request_id: string;
  ok: boolean;
  message?: string;
}

/** `POST /gui/register` body. */
export interface GuiRegisterRequest {
  pid: number;
  version: string;
}

/** `POST /gui/register` payload — the id a GUI passes as `?gui_id=` on /events. */
export interface GuiRegisterData {
  gui_instance_id: string;
}

// ─── SSE events (M2-7) ─────────────────────────────────

/**
 * Every event the daemon pushes over `GET /events`, v0.1 full set. Payloads
 * are deliberately minimal: these are data-bus refresh signals, so a receiver
 * refetches what it has open — there is no replay and no delta protocol.
 *
 * `player:command` is the one exception: it is unicast to the ACTIVE gui
 * connection (never broadcast) and carries the ack correlation id.
 *
 * `download:*` / `cache:evicted` are typed here but only emitted from M3/M5.
 */
export type PlayerCommandEvent = { type: 'player:command'; request_id: string } & PlayerCommand;

export type LarkEvent =
  | { type: 'hello'; server_time: number }
  | { type: 'songs:changed' }
  | { type: 'playlists:changed' }
  | { type: 'lyrics:changed'; song_id: string }
  | PlayerCommandEvent
  | { type: 'download:status'; task_id: string }
  | { type: 'download:complete'; task_id: string; song_id: string }
  | { type: 'download:error'; task_id: string; message: string }
  | { type: 'cache:evicted' };
