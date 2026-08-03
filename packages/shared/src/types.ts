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

/** Playlist wire shape. `song_count` is filled by list queries. */
export interface PlaylistData {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  song_count?: number;
}

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
