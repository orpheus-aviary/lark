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

/**
 * `PUT /songs/:id` body. All fields optional — only what is present is
 * validated and written. The source triple rules on the combination (M1 four
 * quadrants); a pasted URL with no key triggers online normalisation (M3).
 */
export interface UpdateSongRequest {
  name?: string;
  artist?: string;
  lyrics_offset?: number;
  duration?: number;
  source_url?: string | null;
  source_provider?: string | null;
  source_key?: string | null;
}

/** `PUT /songs/:id/pin` body. */
export interface PinSongRequest {
  pinned: boolean;
}

/** `POST /songs/import` body — absolute paths of local mp3 files. */
export interface ImportSongsRequest {
  file_paths: readonly string[];
}

/** `POST /playlists` and `PUT /playlists/:id` body. */
export interface PlaylistNameRequest {
  name: string;
}

/** `POST /playlists/:id/songs` body. */
export interface PlaylistAddSongsRequest {
  song_ids: readonly string[];
}

/** `POST /playlists/:id/songs` payload. */
export interface PlaylistSongsAddedData {
  added: number;
}

/**
 * `POST /playlists/:id/reorder` body. Neighbour ids, never a rank or an
 * index (R7): ranks are sparse floats the wire never sees, and an index is
 * stale the moment another window reorders the same list.
 */
export interface PlaylistReorderRequest {
  song_id: string;
  before_song_id?: string;
  after_song_id?: string;
}

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

/**
 * `GET /api/instance` payload — authenticated instance identity (M4-2).
 *
 * `GET /status` proves liveness but not WHOSE daemon answered; a token round-
 * trip only proves both sides hold a copy of the same token file. This is the
 * one response that ties the port to a data directory, so the GUI can decide
 * between reusing the daemon and refusing the port.
 */
export interface InstanceData {
  /** `realpath()` of the daemon's lark data directory. */
  nest_dir: string;
  pid: number;
  /** Daemon package version. Display only — never a compatibility gate. */
  version: string;
  /** Local HTTP protocol gate; reuse requires an exact match. */
  local_api_version: number;
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

// ─── Cache (M5) ────────────────────────────────────────
//
// Sizes are bytes on the wire; every `*_mb` field is MiB (1 MB = 1,048,576
// bytes), the same unit as `log.max_size_mb`.

/** `GET /cache/status`. */
export interface CacheStatusData {
  /** Total size of every song's `song.mp3` on disk. */
  used_bytes: number;
  /** How many songs have an audio file. */
  file_count: number;
  /** Echo of `storage.cache_limit_mb`; 0 = unlimited. */
  limit_mb: number;
  /**
   * Bytes held by files that pass the STATIC eligibility test: downloaded
   * (never imported, R1), re-downloadable in principle (bilibili + a source
   * key), not pinned, not excluded (playing / queued for download / freshly
   * ensured). NOT network-verified — a key that no longer resolves still
   * counts here and is skipped at eviction time, so the amount an actual
   * eviction frees can be smaller (M5-4).
   */
  eligible_bytes: number;
  /** `used_bytes - eligible_bytes`: what no eviction could ever reclaim. */
  unreclaimable_bytes: number;
  limit_satisfied: boolean;
}

/** `POST /cache/evict`. The inherited fields are RECOMPUTED after the run. */
export interface CacheEvictResultData extends CacheStatusData {
  evicted_count: number;
  freed_bytes: number;
  /**
   * Candidates skipped because the source could not be confirmed
   * re-downloadable (fail-closed, R26). Deduplicated by song id across the
   * rounds of one drain, and a song later evicted leaves the set.
   */
  skipped_unverified_count: number;
  skipped_unverified_bytes: number;
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

/**
 * Body of `POST /player/<command>` — the command name lives in the URL, so
 * the body is the command shape minus its discriminant.
 * `PlayerCommandBody<'play'>` is `{song_id: string}`; commands like `pause`
 * take an empty object.
 */
export type PlayerCommandBody<C extends PlayerCommandName> = Omit<
  Extract<PlayerCommand, { command: C }>,
  'command'
>;

/** `POST /player/<command>` payload — the id the GUI's ack will echo. */
export interface PlayerCommandAcceptedData {
  request_id: string;
}

/** `POST /player/ack` body — late / unknown request_ids are ignored (200). */
export interface AckRequest {
  request_id: string;
  ok: boolean;
  message?: string;
}

/** `POST /player/ack` payload — `matched:false` means the ack arrived late. */
export interface AckResultData {
  matched: boolean;
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

// ─── Download pipeline (M3) ────────────────────────────
//
// The queue is pure memory: a daemon restart clears it, and nothing here is
// ever persisted (M3-5). What IS frozen is the SHAPE, because M4's download
// bar and M6's CLI both render from `GET /download/tasks` snapshots.
//
// `state` and `stage` are separate axes on purpose. `state` is the lifecycle
// (a terminal state is terminal); `stage` is where inside a run the work is,
// and only a running task has one. Collapsing them — the Go version's single
// Chinese progress string — is what made "is it done?" unanswerable.

export const TASK_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * Stages of a running task. No `queued` entry: queuing is a `state`, not a
 * stage. A download task stops at `saving`; `lyrics` belongs to the separate
 * lyrics task a successful download spawns (M3-9).
 */
export const DOWNLOAD_STAGES = [
  'analyzing',
  'searching',
  'resolving',
  'downloading',
  'converting',
  'saving',
  'lyrics',
] as const;
export type DownloadStage = (typeof DOWNLOAD_STAGES)[number];

/**
 * `ensure-file` (M5-8) is "make sure this song's audio is on disk": it reuses
 * the download engine but does nothing at all when the file is already there,
 * which is what makes playing an evicted song a click rather than an error.
 * It is deliberately NOT merged with `redownload`, which is a forced refetch.
 */
export const DOWNLOAD_TASK_KINDS = ['download', 'redownload', 'ensure-file', 'lyrics'] as const;
export type DownloadTaskKind = (typeof DOWNLOAD_TASK_KINDS)[number];

/** What the task was asked to fetch. `url` is the NORMALISED display form. */
export type DownloadTaskInput =
  | { type: 'url'; url: string }
  | { type: 'keyword'; query: string }
  | { type: 'song'; song_id: string };

/**
 * One task's full public state. `revision` increments on every visible change
 * (including ones with no state/stage transition, like a merged playlist
 * target), so a client can drop duplicate `download:status` events by
 * `(state, stage, revision)` without losing a real update (M3-5 三轮 ⑦).
 */
export interface DownloadTaskData {
  id: string;
  kind: DownloadTaskKind;
  state: TaskState;
  /** Only a running task has a stage. */
  stage: DownloadStage | null;
  revision: number;
  input: DownloadTaskInput;
  /** Filled once the task binds to a song — on reuse, or after it creates one. */
  song_id: string | null;
  playlist_ids: readonly string[];
  /**
   * Targets the song did NOT end up in: the playlist was deleted before the
   * task got there, or a late merge failed after the commit point. A soft
   * failure — the task still succeeds — but the GUI has to be able to say so
   * (M3-7 五轮 ⑥).
   */
  failed_playlist_ids: readonly string[];
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error_code: string | null;
  error_message: string | null;
  result: { song_id: string } | null;
}

// Batch targets are two types, not one: the request may ask for a playlist
// that does not exist yet, and the snapshot has to hand back the id it created
// so M4 can navigate to it (M3-5 四轮 ⑤).
export type BatchTargetInput =
  | { kind: 'all' }
  | { kind: 'playlist'; playlist_id: string }
  | { kind: 'new'; name: string };

export type BatchTargetData =
  | { kind: 'all' }
  | { kind: 'playlist'; playlist_id: string; name: string };

/**
 * One requested item. A `keyword` item needs the LLM to pick a video, so the
 * daemon can reject it synchronously when no LLM is configured — no network
 * needed to know that. `title` on a video item is the trustworthy list title
 * from `fetch-list` (the Go version's `UseOrigTitle` path); absent, the
 * pipeline falls back to the video's own title.
 */
export type DownloadBatchItemInput =
  | { kind: 'video'; bvid: string; page: number | null; title: string | null }
  | { kind: 'keyword'; query: string };

export interface DownloadBatchGroupInput {
  target: BatchTargetInput;
  items: readonly DownloadBatchItemInput[];
}

/** `POST /download/batch` body. Every group commits, or none does (M3-5). */
export interface DownloadBatchRequest {
  groups: readonly DownloadBatchGroupInput[];
}

/**
 * `final` is a snapshot written back when the task reaches a terminal state.
 * Terminal tasks age out of the task ring; without the snapshot a batch would
 * silently lose the outcome of its own items.
 */
export interface DownloadBatchItemData {
  index: number;
  task_id: string;
  final: {
    state: 'succeeded' | 'failed' | 'cancelled';
    error_code: string | null;
    song_id: string | null;
  } | null;
}

export interface DownloadBatchData {
  id: string;
  target: BatchTargetData;
  total: number;
  items: readonly DownloadBatchItemData[];
  created_at: number;
}

/** `GET /download/tasks` payload — one refetch answers every download view. */
export interface DownloadTasksData {
  tasks: readonly DownloadTaskData[];
  batches: readonly DownloadBatchData[];
}

/** `POST /download/song` body — a link or a keyword, plus an optional target. */
export interface DownloadSongRequest {
  input: string;
  /** Omitted for the virtual all view (§4.1) — a UUID only, never `'all'`. */
  playlist_id?: string;
}

/** `POST /download/parse` body — one pasted blob, possibly multi-line. */
export interface DownloadParseRequest {
  input: string;
}

/** `POST /download/cancel` body. */
export interface DownloadCancelRequest {
  task_id: string;
}

/** `POST /download/song` / `redownload` / `download/lyrics/:id` payload. */
export interface DownloadTaskAcceptedData {
  task_id: string;
}

/** `POST /download/batch` payload — the full snapshots, not a reduced echo. */
export interface DownloadBatchesData {
  batches: readonly DownloadBatchData[];
}

/** What `POST /download/parse` recognised. Pure preview: nothing is enqueued. */
export type ParsedItem =
  | { kind: 'video'; bvid: string; page: number | null; url: string }
  | { kind: 'favorites'; media_id: string; url: string }
  | { kind: 'collection'; mid: string; season_id: string; url: string }
  | { kind: 'keyword'; query: string };

export interface ParseResultData {
  items: readonly ParsedItem[];
}

/** `POST /download/fetch-list` body. Each list kind has its own required ids. */
export type FetchListRequest =
  | { type: 'favorites'; media_id: string }
  | { type: 'collection'; mid: string; season_id: string };

/**
 * Partial success is the norm here: a 300-video collection whose page 7 fails
 * still yields 6 usable pages, so `videos` carries what was fetched and
 * `error` explains why it stopped.
 */
export interface FetchListData {
  title: string;
  videos: readonly { bvid: string; title: string; duration: number | null }[];
  error: string | null;
}

/** `POST /songs/:id/recognize-url` — a preview, never written to the db (R6). */
export interface RecognizeUrlData {
  source_url: string;
  source_provider: string;
  source_key: string;
  video_title: string;
}

/** `POST /songs/import` — per-file outcomes; one bad file never fails the batch. */
export interface ImportResultData {
  imported: readonly { song_id: string; name: string }[];
  failed: readonly { path: string; reason: string }[];
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
 * `cache:evicted` names the song whose audio file was reclaimed — the row and
 * its lyrics survive, so a receiver refetches the library rather than dropping
 * anything (M5-19).
 *
 * The `download:*` family (M3-6) carries just enough to update a row in place
 * — `{state, stage}` for the progress line, the terminal ones for the toast —
 * and anything richer is a refetch of `GET /download/tasks`.
 * `download:batches-changed` exists because a new batch whose items all
 * dedupe onto already-pending tasks produces no task transition at all, so
 * without it the batch would never appear.
 *
 * `download:status` carries `revision` because `(state, stage)` alone is not
 * unique: binding the song id is a real change that happens while the stage
 * stays `resolving`, so two events legitimately agree on both. The tuple
 * `(state, stage, revision)` is what a client dedupes on (M3-5).
 */
export type PlayerCommandEvent = { type: 'player:command'; request_id: string } & PlayerCommand;

export type LarkEvent =
  | { type: 'hello'; server_time: number }
  | { type: 'songs:changed' }
  | { type: 'playlists:changed' }
  | { type: 'lyrics:changed'; song_id: string }
  | PlayerCommandEvent
  | {
      type: 'download:status';
      task_id: string;
      state: TaskState;
      stage: DownloadStage | null;
      revision: number;
    }
  | { type: 'download:complete'; task_id: string; song_id: string }
  | { type: 'download:error'; task_id: string; error_code: string; message: string }
  | { type: 'download:cancelled'; task_id: string }
  | { type: 'download:batches-changed'; batch_id: string }
  | { type: 'cache:evicted'; song_id: string };
