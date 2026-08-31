// Wire types shared by every lark front-end (Electron renderer, CLI, future
// mobile). snake_case fields mirror the daemon's HTTP payloads verbatim;
// interface names are PascalCase. Kept free of any Node / Electron / DOM-host
// concept so the same definitions compile everywhere.

import type { ImportFileErrorCode } from './error-codes.js';
import type { SyncState } from './sync-types.js';

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

/**
 * `POST /songs/import` body — absolute paths of local audio files.
 *
 * Any of `IMPORT_AUDIO_EXTENSIONS`; the library holds one format, so each one
 * is converted on the way in (§3.4).
 */
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

/**
 * `GET /status` payload — the daemon liveness probe (permanently unauthed).
 *
 * `nest_fingerprint` and `local_api_version` are what let an unauthenticated
 * caller settle IDENTITY, not just liveness (M6-19): before them, a CLI facing
 * an occupied port could not tell "my daemon" from "another nest's daemon"
 * without a token the other nest would never accept.
 *
 * Both are REQUIRED from M6 on. A response carrying neither is a pre-M6 daemon
 * (the legacy shape); one carrying a malformed or half-present pair is not
 * something to guess about — probes treat it as unverifiable and refuse.
 */
export interface StatusData {
  status: 'ok';
  /** Daemon process id, used by the GUI to adopt / replace a running daemon. */
  pid: number;
  /** Seconds since the daemon process started. */
  uptime: number;
  /** Daemon package version. */
  version: string;
  /**
   * SHA-256 (64 lowercase hex) of the daemon's `realpath(larkDir())`. Proves
   * two processes mean the same data directory without publishing the path:
   * the hash leaks path EQUALITY and is guessable by dictionary, which is
   * accepted on a 127.0.0.1 socket behind the Host whitelist.
   */
  nest_fingerprint: string;
  /** Local HTTP protocol gate — same value `GET /api/instance` reports. */
  local_api_version: number;
  /**
   * The one-time mp3 → m4a migration (0.3.0, master plan §3.2-4).
   *
   * On the UNAUTHENTICATED probe, so a GUI that cannot reach any business
   * route yet can still say why. Counts and a state word only — the per-object
   * detail, including anything a file path could leak, is behind
   * `GET /api/audio-migration`.
   *
   * OPTIONAL on the wire, and it is not the usual "we might add it later":
   * `/status` is the one response any lark can answer, including a 0.2.x daemon
   * that occupies the port. A client that read this as always-present would
   * crash on the very probe whose job is to identify a stranger.
   */
  audio_migration?: AudioMigrationCounts;
}

/**
 * How far the daemon has come up (master plan §3.2-3).
 *
 * `pending` and `activating` both refuse business routes; they are separate
 * because only the first has a migration to watch, and the second is the window
 * where the normal runtime is being built — a request answered there would find
 * half a daemon.
 */
export type DaemonPhase = 'pending' | 'activating' | 'normal' | 'fatal';

/**
 * What the migration pass is doing.
 *
 * `idle` means this boot never had one to run — the library was already single-
 * format. The counts can still be non-zero there: the ledger is kept as the
 * report of the run that did happen (§3.2-8).
 */
export type AudioMigrationState =
  | 'idle'
  | 'running'
  /** Preflight failed or the machine broke mid-pass; nothing was deleted. */
  | 'blocked_environment'
  /** The pass has nothing left it can do on its own. */
  | 'needs_attention'
  | 'finished';

/**
 * What the pass did with one object, as the ledger's CHECK constraint spells
 * it. Declared here rather than in core so the daemon, the CLI and the GUI
 * share one spelling with the table (0.3.0 §3.2-8).
 *
 * A type, not a `readonly []` like `SYNC_FILE_OP_STATES`: nothing validates an
 * incoming status against this set — the values only ever come OUT of the
 * ledger, whose CHECK constraint is the enforcement.
 */
export type AudioMigrationStatus =
  | 'pending'
  | 'converting'
  | 'discarding'
  | 'backing_up'
  | 'done'
  | 'lost'
  | 'kept_unconverted'
  | 'asset_missing'
  | 'blocked'
  | 'blocked_file_op';

/** R = rebuildable, A = user asset, orphan = a directory with no library row. */
export type AudioMigrationClass = 'R' | 'A' | 'orphan';

/** `GET /status`'s migration summary — counts, never paths. */
export interface AudioMigrationCounts {
  phase: DaemonPhase;
  state: AudioMigrationState;
  /** Objects the scan found holding an mp3. Work, not library size. */
  total: number;
  done: number;
  /** R-class: the mp3 was unreadable and the source answered. */
  lost: number;
  /** A-class: kept as-is in `migration-backup/`. */
  kept_unconverted: number;
  /** The mp3 vanished with no backup holding it. Never reported as done. */
  asset_missing: number;
  /** A file action failed; a person has to look. */
  blocked: number;
  /** A sync file op still owns the directory. */
  blocked_file_op: number;
}

/**
 * One object in the migration report (`GET /api/audio-migration`).
 *
 * Names only — `object_key` is a directory name under `songs/`, `backup_file`
 * a name under `migration-backup/`. No absolute path leaves the daemon here
 * (§3.2-4), and `last_error` is scrubbed of them before it is sent: ffmpeg's
 * complaints are quoted verbatim otherwise.
 */
export interface AudioMigrationObjectData {
  object_key: string;
  song_id: string | null;
  class: AudioMigrationClass;
  status: AudioMigrationStatus;
  file_origin: string | null;
  /** Which file action failed, on a `blocked` row. A report field, not an order. */
  blocked_action: string | null;
  error_class: string | null;
  last_error: string | null;
  backup_file: string | null;
  reconcile_action: string | null;
  at: number;
}

/**
 * What `migration-backup/` is holding.
 *
 * `asset_*` is the subset that cannot be recovered any other way: the originals
 * of `kept_unconverted` objects, which by definition could not be converted and
 * are not downloadable. The rest are originals of songs that also exist as m4a.
 * A "clear the backup" button that does not draw this line is asking the user
 * to gamble on a number.
 */
export interface AudioMigrationBackupData {
  file_count: number;
  bytes: number;
  asset_count: number;
  asset_bytes: number;
}

/** `GET /api/audio-migration` — the full report. Readable after it finishes. */
export interface AudioMigrationData {
  counts: AudioMigrationCounts;
  /** Why the pass stopped, when the machine is the reason. Paths scrubbed. */
  reason: string | null;
  objects: AudioMigrationObjectData[];
  backup: AudioMigrationBackupData;
}

/** `POST /api/audio-migration/retry`. */
export interface AudioMigrationRetryData {
  /**
   * Whether this call actually re-ran the pass. False once the library is
   * being served: a conversion running beside the download engine would touch
   * song directories nothing is holding a claim on.
   */
  started: boolean;
  counts: AudioMigrationCounts;
  reason: string | null;
}

/** `POST /api/audio-migration/backup/clear`. */
export interface AudioMigrationBackupClearData {
  removed_count: number;
  freed_bytes: number;
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

/**
 * Where ffmpeg came from and whether it can do the job (M7-18).
 *
 * `source` says which of the four resolution levels won, which is the
 * difference between "the bundled copy" and "the one you installed" — the
 * question a bug report about a broken download has to answer first. Both
 * paths are `null` unless the state is `ready`: naming a binary that failed to
 * answer would read as "we found this and it works".
 */
export type MediaToolSource = 'env' | 'bundle' | 'homebrew' | 'path';

export interface MediaToolInfo {
  path: string;
  source: MediaToolSource;
}

export interface MediaToolsInfo {
  state: 'ready' | 'missing' | 'incompatible';
  ffmpeg: MediaToolInfo | null;
  ffprobe: MediaToolInfo | null;
  /** Safe to show a user. `null` when ready. */
  detail: string | null;
}

export interface CapabilitiesData {
  name: 'lark';
  version: string;
  endpoints: CapabilityEndpoint[];
  /**
   * Required since LOCAL_API_VERSION 4. Download, import and redownload all
   * refuse with `MEDIA_TOOLS_UNAVAILABLE` when this is not `ready`, so a client
   * that renders those actions has to be able to see it coming.
   */
  media_tools: MediaToolsInfo;
  /**
   * Is an LLM configured (0.3.0 §3.6-1)? The same reason as `media_tools`:
   * keyword search and `naming_mode: 'clean'` are refused without one, so a
   * client that offers either has to be able to grey it out first rather than
   * let the user pick something that will be rejected.
   */
  llm_available: boolean;
  /**
   * The one format the library stores (0.3.0). A constant for this build, and
   * on the wire anyway: a client that shows what it is about to play — or that
   * writes a file name — should read it rather than assume, and the assumption
   * it would otherwise carry is the one 0.2.x was built on.
   */
  audio_format: 'm4a';
  /** Extensions `POST /songs/import` accepts, without the dot (§3.4). */
  import_formats: readonly string[];
  /**
   * Which protocol the LLM client will actually speak (§7 F5).
   *
   * `GET /config` can only report what lark's OWN file says, and `''` there
   * means "follow aviary's shared config" — a settings page that rendered that
   * as a protocol would be guessing, and the guess it used to make was
   * `openai`. This is the resolved answer, so the field can say
   * "follow aviary (currently: anthropic)" and be right.
   */
  llm_effective_format: string;
}

// ─── Cache (M5) ────────────────────────────────────────
//
// Sizes are bytes on the wire; every `*_mb` field is MiB (1 MB = 1,048,576
// bytes), the same unit as `log.max_size_mb`.

/** `GET /cache/status`. */
export interface CacheStatusData {
  /** Total size of every song's `song.m4a` on disk. */
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

  // ── The other libraries on this device (N7) ─────────────────────────────
  //
  // The limit is a DEVICE setting — how much room lark may take on this
  // machine — so once there are several workspaces the figure above stops
  // being the whole story. `used_bytes + other_bytes` is every byte of lark
  // audio on the disk, and `limit_satisfied` is judged against that sum.

  /** Audio held by every workspace except the one this daemon is serving. */
  other_bytes: number;
  other_files: number;
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

// ─── Playlist transfer (M5) ────────────────────────────
//
// The export file is the interchange format, so it is versioned and carries no
// song ids: an import always mints fresh UUIDs (R10). `source_provider` /
// `source_key` ARE in the file even though a url is there too — round-trip
// dedup must not depend on how a future build normalises URLs (R27).

export const PLAYLIST_EXPORT_FORMAT = 'lark-playlist';
export const PLAYLIST_EXPORT_VERSION = 1;

export interface PlaylistExportSong {
  name: string;
  artist: string;
  source_url: string | null;
  source_provider: string | null;
  source_key: string | null;
  lyrics_offset: number;
  duration: number;
}

/** `GET /playlists/:id/export` payload — also the file's contents verbatim. */
export interface PlaylistExportData {
  format: typeof PLAYLIST_EXPORT_FORMAT;
  version: number;
  exported_at: number;
  playlist: { name: string };
  songs: readonly PlaylistExportSong[];
}

/**
 * `POST /playlists/import-preview` body. A path, not the bytes: the file can be
 * 20MB and Fastify's body limit is 1MB — the same reason `POST /songs/import`
 * takes paths (M5-13).
 */
export interface PlaylistImportPreviewRequest {
  file_path: string;
}

/** A library song that could be what an entry means. `has_file` is a disk probe. */
export interface ImportCandidate {
  id: string;
  name: string;
  artist: string;
  has_file: boolean;
}

/**
 * An entry whose name+artist already exist in the library under a different
 * (or absent) source key — a live/remix/alternate cut just as easily as a
 * duplicate, so the default is ALWAYS to import it as a new song (R12).
 */
export interface ImportSuspect {
  /** Position in the file's `songs` array — what `reuse[].index` refers to. */
  index: number;
  name: string;
  artist: string;
  candidates: readonly ImportCandidate[];
}

export interface PlaylistImportPreviewData {
  /** SHA-256 of the file, hex. The commit must send it back (M5-13). */
  digest: string;
  total: number;
  /**
   * Input entries that will reuse an existing song: a `(provider, key)` hit in
   * the library, or a repeat of a key seen earlier in the same file.
   */
  reuse_count: number;
  /** `total - reuse_count`. Suspects count as new — that is the default. */
  new_count: number;
  /** `playlist.name` from the file, the default name for a new playlist. */
  playlist_name: string;
  suspects: readonly ImportSuspect[];
}

/** Where an import lands. `all` means "into the library only", no membership. */
export type PlaylistImportTarget =
  | { kind: 'all' }
  | { kind: 'playlist'; playlist_id: string }
  | { kind: 'new'; name: string };

/**
 * `POST /playlists/import` body. `digest` must match the previewed file byte
 * for byte, which is what makes `reuse[].index` mean the same thing on both
 * sides; a mismatch answers `IMPORT_SOURCE_CHANGED` rather than importing
 * against stale indices.
 */
export interface PlaylistImportRequest {
  file_path: string;
  digest: string;
  target: PlaylistImportTarget;
  /** Entries the user chose to merge into an existing song instead. */
  reuse?: readonly { index: number; song_id: string }[];
}

/** `POST /playlists/import` payload — one all-or-nothing transaction (R27). */
export interface PlaylistImportData {
  /** The target playlist, or null for an import into the library only. */
  playlist_id: string | null;
  total: number;
  /** Songs created. */
  created: number;
  /** Entries that resolved onto an existing song. */
  reused: number;
  /** Playlist memberships actually added (already-members are skipped). */
  added: number;
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
  // Asking the model for the song and the artist inside the title (0.3.0
  // §3.6-2). Only on the `clean` naming path, and only between having the
  // video and starting the transfer — an `original` download never reports it.
  'naming',
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
 * The two things a batch can be picked out of. A named domain because the
 * daemon validates against it and both origins carry it (0.5.0 ④).
 */
export const DOWNLOAD_LIST_KINDS = ['favorites', 'collection'] as const;
export type DownloadListKind = (typeof DOWNLOAD_LIST_KINDS)[number];

/**
 * Where a download was asked for (0.5.0 ④). SEPARATE FROM `DownloadTaskInput`,
 * which is what to fetch: a video queued from a collection and the same video
 * queued from a pasted link fetch the identical thing, and the whole question
 * a download record has to answer afterwards is which of the two happened.
 *
 * Baked at enqueue rather than derived later. The engine's batch ring holds
 * the last few batches; the phone's history file holds two hundred downloads
 * for as long as somebody keeps the app, so「第几条」 has to survive the ring
 * that could have computed it.
 */
export type DownloadOrigin =
  /** Typed a song name. `query` is what they typed. */
  | { kind: 'keyword'; query: string }
  /** One link. `url` carries `?p=` when the video has parts. */
  | { kind: 'video'; url: string }
  /**
   * One entry out of a favourites folder or a collection.
   *
   * `url` is the LIST's own link and `video_url` this entry's — the two are
   * different questions, and the copy button answers the second one.
   * `index` is 1-based, for「（3/50）」.
   */
  | {
      kind: 'list';
      list: DownloadListKind;
      title: string;
      url: string;
      video_url: string;
      index: number;
      total: number;
    }
  /** Started from a song already in the library: a redownload, an ensure, lyrics. */
  | { kind: 'song'; song_id: string };

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
  /** Who asked for it, as opposed to what it fetches (0.5.0 ④). */
  origin: DownloadOrigin;
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
  /**
   * Bytes of audio transferred so far (0.3.0 §3.5).
   *
   * Only meaningful during `downloading`: it is zeroed on every stage change,
   * and monotonic within one. A client reading it in another stage sees 0,
   * which is the truth about how much of THIS stage has moved.
   */
  received_bytes: number;
  /**
   * What the source said the transfer would be, or `null` when it did not say
   * (no `content-length`, or a chunked response). `null` is a real answer and
   * not zero: "unknown size" and "empty file" ask a progress line for
   * different things.
   */
  total_bytes: number | null;
  /**
   * The song this task is about, as soon as anyone can name it.
   *
   * A task that starts from a song (redownload / ensure-file / lyrics) has it
   * from the moment it is queued; a link has it once the target resolves —
   * which is the point of `naming`, and the only place the choice between the
   * original title and a cleaned one becomes visible.
   *
   * `null` until then, and a client must fall back to the input rather than
   * invent one: a queued link genuinely has no name yet.
   */
  title: string | null;
  /** The artist beside `title`, blank when the source gave none. */
  artist: string | null;
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
 * How a video's song name is decided (0.3.0 §3.6-1).
 *
 * `original` stores the title as it stands — the list's title when one came
 * with it, the video's own otherwise. `clean` asks the LLM for the song and
 * the artist inside that title, falling back to the title and the uploader
 * when it cannot tell.
 *
 * It is a mode rather than a boolean because the two are not "on and off" of
 * one thing: they read different sources and cost different amounts, and the
 * user picks per submission.
 */
export const DOWNLOAD_NAMING_MODES = ['original', 'clean'] as const;
export type DownloadNamingMode = (typeof DOWNLOAD_NAMING_MODES)[number];

/**
 * One requested item. A `keyword` item needs the LLM to pick a video, so the
 * daemon can reject it synchronously when no LLM is configured — no network
 * needed to know that. `title` on a video item is the trustworthy list title
 * from `fetch-list` (the Go version's `UseOrigTitle` path); absent, the
 * pipeline falls back to the video's own title.
 *
 * `naming` is required on a video item, and absent on a keyword one: a keyword
 * search has no title to keep, so it has always run the model (§3.6-1).
 */
export type DownloadBatchItemInput =
  | {
      kind: 'video';
      bvid: string;
      page: number | null;
      title: string | null;
      naming: DownloadNamingMode;
    }
  | { kind: 'keyword'; query: string };

export interface DownloadBatchGroupInput {
  target: BatchTargetInput;
  items: readonly DownloadBatchItemInput[];
  /**
   * The favourites folder or collection these items were picked out of, when
   * they were (0.5.0 ④). Absent for a group of pasted links or keywords —
   * those have no list identity, and inventing one would be a lie the download
   * record then repeats forever.
   */
  source?: { list: DownloadListKind; title: string; url: string };
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
  /**
   * Conditionally required (§3.6-1): mandatory when `input` is a video link,
   * REFUSED when it is a keyword. Optional in the type because one field
   * cannot be two things — the daemon knows which shape the input is only
   * after parsing it, and answers `INVALID_BODY` either way round.
   */
  naming_mode?: DownloadNamingMode;
}

/** `POST /download/parse` body — one pasted blob, possibly multi-line. */
export interface DownloadParseRequest {
  input: string;
}

/** `POST /download/cancel` body. */
export interface DownloadCancelRequest {
  task_id: string;
}

/**
 * `POST /download/cancel-all` payload — one entry per task that was active
 * when the request arrived (§4-f).
 *
 * Best-effort by construction, and per-item because the three outcomes are
 * genuinely different: a queued task is `cancelled` on the spot, a running one
 * is asked to stop and is still `running` when this answers, and one already
 * past the commit point cannot be cancelled at all. Reporting a single number
 * would make the last of those look like a failure of the request.
 */
export interface DownloadCancelAllData {
  /** Tasks that reached `cancelled` immediately — queued ones, in practice. */
  cancelled: number;
  results: readonly {
    task_id: string;
    /** The task's state right after the attempt. */
    state: TaskState;
    /** Why it was not cancelled, when it was not. `null` means accepted. */
    error_code: string | null;
  }[];
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

/** `POST /download/parts` body. */
export interface DownloadPartsRequest {
  bvid: string;
}

/** One part, as the picker lists it. `page` is what goes back as `?p=`. */
export interface DownloadPartData {
  page: number;
  /** The part's own title — what the song will be called (0.5.1 §7.4). */
  part: string;
  duration: number | null;
}

/**
 * `POST /download/parts` — one video's parts, for a person to choose among.
 *
 * `title` is the video's own, which for a multi-part upload is the collection
 * name: the picker needs it to say WHAT it is listing the parts of, and the
 * song names come from `part` instead. Both arrive in the same upstream
 * response, so this costs one request, not two.
 *
 * A single-part video answers one entry rather than an error. The caller asked
 * what the parts are and that is the honest answer; refusing would make every
 * caller special-case a case that is not a problem.
 */
export interface DownloadPartsData {
  bvid: string;
  title: string;
  parts: readonly DownloadPartData[];
}

/** `POST /songs/:id/recognize-url` — a preview, never written to the db (R6). */
export interface RecognizeUrlData {
  source_url: string;
  source_provider: string;
  source_key: string;
  video_title: string;
}

/**
 * `POST /songs/import` — per-file outcomes; one bad file never fails the batch.
 *
 * Both arms grew a field in 0.3.0, when import stopped being "copy an mp3" and
 * became a conversion with a decision table behind it (§3.4):
 *
 *   - `warnings` says what the library's copy does NOT carry — a second audio
 *     track that was dropped, a lossless source that is now AAC. The import
 *     succeeded; the user is told what it cost.
 *   - `error_code` classifies a refusal, so a client can tell "this is a
 *     video" from "this machine's ffmpeg choked" without matching on prose.
 */
export interface ImportResultData {
  imported: readonly { song_id: string; name: string; warnings: readonly string[] }[];
  failed: readonly { path: string; reason: string; error_code: ImportFileErrorCode }[];
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
 * `(state, stage, revision)` is what a client dedupes on (M3-5). From 0.3.0
 * byte progress is a third source of "same state, same stage, new event", and
 * it is throttled at the source (§4-d) rather than at every receiver.
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
      /** Same contract as the snapshot's: `downloading` only, zeroed between. */
      received_bytes: number;
      total_bytes: number | null;
      /**
       * The snapshot's `title` / `artist`, repeated here because a client
       * applies these events IN PLACE: a link is named halfway through its
       * task, and a receiver that only learns names from `GET /download/tasks`
       * would show the raw URL until something unrelated made it refetch.
       */
      title: string | null;
      artist: string | null;
    }
  | { type: 'download:complete'; task_id: string; song_id: string }
  | { type: 'download:error'; task_id: string; error_code: string; message: string }
  | { type: 'download:cancelled'; task_id: string }
  | { type: 'download:batches-changed'; batch_id: string }
  | { type: 'cache:evicted'; song_id: string }
  // ── skybridge sync (v0.2, §4.4) ──
  //
  // `sync:status_changed` carries the state and nothing else. The badge needs
  // exactly that to render, and everything the popover shows (counts, seqs,
  // last error) is a `GET /sync/status` away — duplicating those fields here
  // would give a client two sources for the same numbers and no rule for
  // which one is newer.
  | { type: 'sync:status_changed'; state: SyncState }
  | { type: 'conflicts:changed'; count: number }
  // A remote delete moved files into `recovered-songs/` instead of removing
  // them: irreplaceable audio, or lyrics this device never published. Nothing
  // is lost, but nobody would ever look without being told.
  | { type: 'sync:file_quarantined'; song_id: string };
