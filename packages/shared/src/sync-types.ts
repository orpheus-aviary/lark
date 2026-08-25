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

/**
 * Every shape a change may carry. Emit takes this union rather than a loose
 * record: an interface does not satisfy `Record<string, unknown>` anyway (no
 * index signature), and a closed union means a caller cannot invent a payload
 * the apply side has no parser for.
 */
export type SyncChangePayload =
  | SongSyncPayload
  | PlaylistSyncPayload
  | PlaylistSongSyncPayload
  | TombstoneSyncPayload
  | SetLyricsSyncPayload
  | ClearLyricsSyncPayload
  | ReorderSyncPayload
  | SetRankSyncPayload;

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
 * (localhost aside). Every host confirms it in its own way before sending it —
 * the desktop asks twice (a checkbox, then a dialog), the phone reads a switch
 * the user set in settings — so what it means HERE is only "a person has said
 * yes to this", never a particular control.
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

// ─── `/sync/*` responses ───────────────────────────────

/**
 * What a login did, beyond "it worked".
 *
 * `device_reused` and `device_stamp` are here because they explain something
 * the user can otherwise only infer: whether this machine kept its identity in
 * the workspace, and whether the rows on disk were re-attributed as a result.
 */
export interface SyncLoginResultData {
  server_url: string;
  user_id: string;
  email: string;
  device_id: string;
  device_name: string;
  device_reused: boolean;
  workspace_id: string;
  /** What the first bind published, or `null` when nothing was owed. */
  backfill: SyncBackfillSummary | null;
  /** Entities whose unpushed keys were rebased onto the server clock (§3.3). */
  rebased_entities: number;
  device_stamp: 'first-registration' | 'device-changed' | 'unchanged';
}

export interface SyncBackfillSummary {
  songs: number;
  playlists: number;
  memberships: number;
  lyrics: number;
  /** Songs whose lyrics a pending change already covers (R5-2). */
  lyrics_skipped: number;
  /** Songs whose lyrics are too large to ever push (D3). */
  lyrics_oversize: number;
}

export interface SyncLogoutResultData {
  had_session: boolean;
  /** False when the server could not be told; the local session is gone either way. */
  revoked_remotely: boolean;
}

/** What one round moved. */
export interface SyncRunResultData {
  pulled: number;
  pushed: number;
  applied: number;
  skipped: number;
  dead_lettered: number;
  conflicts: number;
  /** True when the round stopped early because the session was replaced. */
  cancelled: boolean;
  pulled_seq: number;
  pushed_seq: number;
}

/** One row of `GET /sync/devices`. */
export interface SyncDeviceData {
  id: string;
  name: string;
  platform: string | null;
  app_version: string | null;
  client_version: string | null;
  created_at: number;
  last_seen_at: number;
  /** Non-null once revoked; a revoked device can still be listed. */
  revoked_at: number | null;
  /** True for the device this daemon is — never offer to revoke yourself by accident. */
  is_current: boolean;
}

export interface SyncDevicesData {
  devices: SyncDeviceData[];
}

export interface SyncRevokeDeviceRequest {
  device_id: string;
}

export interface SyncFileOpsData {
  file_ops: SyncFileOpSummary[];
}

/** What a retry drained. `skipped` counts rows left alone (busy, backing off). */
export interface SyncFileOpRunData {
  executed: number;
  failed: number;
  skipped: number;
}

// ─── `/conflicts/*` ────────────────────────────────────

/**
 * One conflict receipt: the two versions and the keys that decided between
 * them. `remote` is what the row holds now; `local` is what this device had
 * and can put back.
 */
export interface ConflictData {
  id: string;
  entity_type: string;
  entity_id: string;
  detected_at: number;
  remote_seq: number | null;
  local_payload: SongSyncPayload | null;
  remote_payload: SongSyncPayload | null;
  local_key: LwwKey;
  remote_key: LwwKey;
}

export interface ConflictListData {
  conflicts: ConflictData[];
}

export interface ConflictCountData {
  count: number;
}
