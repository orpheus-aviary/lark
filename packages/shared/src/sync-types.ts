// sync v1 wire contract (v0.2, plan §3 + §4.4).
//
// Two different wires meet in this file, and keeping them apart matters:
//
//   lark ⇄ skybridge — the `payload` shapes below travel inside a skybridge
//     change envelope. skybridge itself is payload-agnostic, so THESE are the
//     definitions both ends of a lark pair validate against. They are frozen
//     under workspace `schema_version = 1`: changing a field here is a protocol
//     break that needs a version bump on both sides, not an edit.
//   front-end ⇄ daemon — the `/sync/*` request and response shapes, same
//     snake_case house style as the rest of the wire contract.
//
// Node-free like the rest of @lark/shared: core validates against these types
// but never imports a skybridge package, and the renderer type-graph stays
// clear of both.

// ─── Protocol identity ─────────────────────────────────

/** Workspace `schema_version` this build speaks. Mismatch = refuse to bind. */
export const SYNC_SCHEMA_VERSION = 1;

/** skybridge workspace coordinates: one workspace per tool, single account. */
export const SYNC_WORKSPACE_TOOL = 'lark';
export const SYNC_WORKSPACE_NAME = 'default';

// ─── Entities and ops ──────────────────────────────────

export const SYNC_ENTITY_TYPES = ['song', 'playlist', 'playlist_song'] as const;
export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

/**
 * Ops per entity. The split that runs through the whole design:
 *
 *   LWW put / tombstone (`create`, `update`, `delete`) carry the
 *     `(updated_at_ms, lww_counter, device_id)` key, are compared against the
 *     local row, and a device SKIPS the echo of its own change.
 *   metadata ops (`set_lyrics`, `clear_lyrics`, `reorder`, `set_rank`) carry
 *     no key, order by `server_seq` alone, and are REPLAYED even when they are
 *     this device's own echo — that replay is what makes them converge.
 */
export const SONG_SYNC_OPS = ['create', 'update', 'delete', 'set_lyrics', 'clear_lyrics'] as const;
export type SongSyncOp = (typeof SONG_SYNC_OPS)[number];

export const PLAYLIST_SYNC_OPS = ['create', 'update', 'delete', 'reorder'] as const;
export type PlaylistSyncOp = (typeof PLAYLIST_SYNC_OPS)[number];

export const PLAYLIST_SONG_SYNC_OPS = ['create', 'delete', 'set_rank'] as const;
export type PlaylistSongSyncOp = (typeof PLAYLIST_SONG_SYNC_OPS)[number];

export type SyncOp = SongSyncOp | PlaylistSyncOp | PlaylistSongSyncOp;

/** `playlist_song` entity ids are the composite `${playlist_id}:${song_id}`. */
export function membershipEntityId(playlistId: string, songId: string): string {
  return `${playlistId}:${songId}`;
}

// ─── LWW keys and payloads ─────────────────────────────

/**
 * The full LWW key, compared as a strict lexicographic triple. A NULL
 * `device_id` normalizes to `''` for comparison — never to "unknown wins".
 */
export interface LwwKey {
  updated_at_ms: number;
  lww_counter: number;
  device_id: string | null;
}

/**
 * Full song state. `created_at_ms` is immutable: an insert adopts it, an
 * update against an existing row ignores it — otherwise two devices that
 * created "the same" song at different times would keep flipping it.
 * `device_id` is NOT here; it comes off the change envelope (§3.10).
 */
export interface SongSyncPayload {
  name: string;
  artist: string;
  source_url: string | null;
  source_provider: string | null;
  source_key: string | null;
  lyrics_offset: number;
  duration: number;
  created_at_ms: number;
  updated_at_ms: number;
  lww_counter: number;
}

export interface PlaylistSyncPayload {
  name: string;
  created_at_ms: number;
  updated_at_ms: number;
  lww_counter: number;
}

/**
 * Membership existence. Deliberately WITHOUT `rank` (§3.1, R4-2): rank travels
 * on `set_rank` only. A rank here would be a second channel that LWW put
 * cannot replay on the emitting device, and the two channels diverge.
 */
export interface PlaylistSongSyncPayload {
  playlist_id: string;
  song_id: string;
  added_at_ms: number;
  updated_at_ms: number;
  lww_counter: number;
}

/** Tombstone payload — the losing side of a delete only needs the key. */
export interface TombstoneSyncPayload {
  updated_at_ms: number;
  lww_counter: number;
}

export interface SetLyricsSyncPayload {
  lrc: string;
}

/** `clear_lyrics` carries no fields; the op itself is the whole message. */
export type ClearLyricsSyncPayload = Record<string, never>;

export interface ReorderSyncPayload {
  song_ids: string[];
}

export interface SetRankSyncPayload {
  rank: number;
}

// ─── `GET /sync/status` ────────────────────────────────

/**
 * `auth_required` is a state, not an error: the daemon keeps running, stops
 * syncing, and says why. `offline` means the server could not be reached.
 */
export const SYNC_STATES = ['idle', 'syncing', 'error', 'offline', 'auth_required'] as const;
export type SyncState = (typeof SYNC_STATES)[number];

/**
 * Why sync is in `auth_required`, in priority order: `missing_session` (no
 * credentials on disk yet) < `token_rejected` (the server refused what we had)
 * < `credentials_missing` (the file lost its `[auth]` section). Same three owl
 * settled on in 0.6.2.
 */
export const SYNC_AUTH_REASONS = [
  'missing_session',
  'token_rejected',
  'credentials_missing',
] as const;
export type SyncAuthReason = (typeof SYNC_AUTH_REASONS)[number];

/**
 * Everything the badge, the popover and `lark sync status` render.
 *
 * `bound` is separate from `authenticated` on purpose: a logged-out install
 * that still carries its binding is a normal state (log back in and continue),
 * while a bound install talking to a DIFFERENT workspace is a refusal.
 *
 * The four file counters and `quarantined_count` are read from the journal and
 * the `recovered-songs/` directory rather than from memory — a failure that
 * survived a restart has to stay visible, or the user's only clue is a song
 * that quietly never plays.
 */
export interface SyncStatusData {
  configured: boolean;
  authenticated: boolean;
  bound: boolean;
  server_url: string | null;
  device_id: string | null;
  workspace_id: string | null;
  pending_count: number;
  pulled_seq: number;
  pushed_seq: number;
  last_sync_at: number | null;
  state: SyncState;
  /** Non-null iff `state === 'auth_required'`. */
  auth_reason: SyncAuthReason | null;
  last_error: string | null;
  dead_letters: { in: number; out: number };
  /** Songs sharing a `(provider, key)` with another song (D8 coexistence). */
  duplicate_source_keys: number;
  pending_file_ops: number;
  file_op_failures: number;
  quarantined_count: number;
  last_file_error: string | null;
}

// ─── `/sync/*` requests ────────────────────────────────

/**
 * `POST /sync/login`. The password is used once, never stored, never logged.
 * `allow_insecure_http` is the explicit breaker for a non-HTTPS `server_url`
 * (localhost aside) and is confirmed twice in the UI before it gets here.
 */
export interface SyncLoginRequest {
  server_url: string;
  email: string;
  password: string;
  allow_insecure_http?: boolean;
}

export const SYNC_FILE_OP_STATES = ['pending', 'failed'] as const;
export type SyncFileOpState = (typeof SYNC_FILE_OP_STATES)[number];

/**
 * One row of `GET /sync/file-ops`, redacted: inline lyrics in the journal arg
 * are reported as size + digest and the text itself never crosses the wire.
 * This list is how a caller learns the ids that retry / discard take.
 */
export interface SyncFileOpSummary {
  id: number;
  kind: string;
  song_id: string;
  attempts: number;
  last_error: string | null;
  next_retry_at: number | null;
  created_at: number;
  /** Present when the op carries an inline body (lyrics), never the body. */
  inline: { size: number; sha256: string } | null;
}

/** Omitting `id` retries every failed row. */
export interface SyncFileOpRetryRequest {
  id?: number;
}

/** Discard is per-row and permanent — no "discard everything" shape exists. */
export interface SyncFileOpDiscardRequest {
  id: number;
}

/**
 * `POST /conflicts/:id/resolve`. `expected_current` is the remote winner's LWW
 * triple as it was written to the row when the conflict was recorded; if the
 * row has moved on since, the resolve is refused instead of overwriting a
 * newer value the user never saw.
 */
export interface ConflictResolveRequest {
  strategy: 'local' | 'remote';
  expected_current: LwwKey;
}
