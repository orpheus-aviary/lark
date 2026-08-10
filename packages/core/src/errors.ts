// Structured error types (T3). daemon / CLI / GUI render UX by instanceof +
// fields — never by parsing message strings. All exported from the core barrel.

/**
 * createDatabase found the Go-era songs.db (user_version=0, non-empty,
 * playlists.is_system present). Never auto-migrated — the user runs
 * `just migrate-go` explicitly (M1-7).
 */
export class GoMigrationRequiredError extends Error {
  readonly dbPath: string;
  constructor(dbPath: string) {
    super(
      `Database at ${dbPath} is a Go-version lark library and must be migrated first. Run \`just migrate-go\` (the Go app cannot open the library afterwards).`,
    );
    this.name = 'GoMigrationRequiredError';
    this.dbPath = dbPath;
  }
}

/**
 * The db was written by a newer build (user_version > LATEST_KNOWN_VERSION),
 * or carries an unrecognizable v0 schema. Refused with zero writes.
 */
export class IncompatibleDbError extends Error {
  readonly dbPath: string;
  readonly dbVersion: number;
  constructor(dbPath: string, dbVersion: number, maxSupported: number) {
    super(
      dbVersion === 0
        ? `Database at ${dbPath} has an unrecognized schema at user_version=0; refusing to touch it.`
        : `Database at ${dbPath} is at v${dbVersion}, but this build only supports up to v${maxSupported}. Upgrade the application.`,
    );
    this.name = 'IncompatibleDbError';
    this.dbPath = dbPath;
    this.dbVersion = dbVersion;
  }
}

export type MigrationBusyReason =
  | 'migrate_lock_busy'
  | 'daemon_alive'
  | 'exclusive_lock_busy'
  | 'checkpoint_busy';

/** Another process is interacting with the db (migration / daemon / external tool). */
export class MigrationBusyError extends Error {
  readonly reason: MigrationBusyReason;
  constructor(reason: MigrationBusyReason, message: string) {
    super(message);
    this.name = 'MigrationBusyError';
    this.reason = reason;
  }
}

/**
 * `lark_config.toml` is group- or world-accessible and the caller is a READ
 * path, which may not repair it (M6-23). The file holds a live api_key, so
 * this is a refusal, not a warning.
 */
export class ConfigUnsafePermissionsError extends Error {
  readonly path: string;
  readonly mode: number;
  constructor(path: string, mode: number) {
    super(
      `config file ${path} has unsafe mode 0${mode.toString(8)} (it holds an api_key). Run any lark write command, or start the daemon once, to tighten it to 0600.`,
    );
    this.name = 'ConfigUnsafePermissionsError';
    this.path = path;
    this.mode = mode;
  }
}

/**
 * There is no library here yet: no file at all, or a file with an empty
 * schema. A write path would create one; a read path has nothing to show and
 * says so (M6-20).
 */
export class DatabaseNotInitializedError extends Error {
  readonly dbPath: string;
  constructor(dbPath: string) {
    super(
      `No lark library at ${dbPath} yet. Start the daemon once (\`lark daemon\`) — it creates the library, and finishes an interrupted migration if there is one.`,
    );
    this.name = 'DatabaseNotInitializedError';
    this.dbPath = dbPath;
  }
}

/**
 * The library is at an older schema version this build knows how to migrate,
 * but the caller is a READ path and read paths do not migrate (M6-20).
 */
export class MigrationPendingError extends Error {
  readonly dbPath: string;
  readonly dbVersion: number;
  constructor(dbPath: string, dbVersion: number, target: number) {
    super(
      `Database at ${dbPath} is at v${dbVersion} and this build expects v${target}. Start the daemon once (\`lark daemon\`) to complete the upgrade, then retry.`,
    );
    this.name = 'MigrationPendingError';
    this.dbPath = dbPath;
    this.dbVersion = dbVersion;
  }
}

/**
 * Another process holds the cross-process writer lock for this library
 * (M6-18): a running daemon, a `lark --direct` write, a Go migration or a nest
 * backup. Never a stale-lock false positive — the lock is an fcntl lock the
 * kernel drops when its holder dies.
 */
export class WriterLockBusyError extends Error {
  readonly dbPath: string;
  /** How long the caller was willing to wait, in ms (0 = did not wait). */
  readonly waitedMs: number;
  constructor(dbPath: string, waitedMs: number) {
    super(
      waitedMs > 0
        ? `another process is writing the lark library at ${dbPath} (waited ${waitedMs}ms for the writer lock) — stop the daemon or wait for the migration / backup to finish`
        : `another process is writing the lark library at ${dbPath} — stop the daemon or wait for the migration / backup to finish`,
    );
    this.name = 'WriterLockBusyError';
    this.dbPath = dbPath;
    this.waitedMs = waitedMs;
  }
}

/**
 * Crash residue around a migration ({main, .migrating, .old-swap}) is in a
 * state that cannot be resolved automatically. Fail-closed: nothing was
 * deleted — the message carries manual-recovery guidance (M1-10).
 */
export class MigrationResidueError extends Error {
  readonly dbPath: string;
  readonly details: string;
  constructor(dbPath: string, details: string) {
    super(`Migration residue at ${dbPath} needs manual attention: ${details}`);
    this.name = 'MigrationResidueError';
    this.dbPath = dbPath;
    this.details = details;
  }
}

/** A table/column/index/CHECK doesn't match the schema this build expects. */
export class SchemaMismatchError extends Error {
  readonly dbPath: string;
  readonly details: string;
  constructor(dbPath: string, details: string) {
    super(`Schema mismatch at ${dbPath}: ${details}`);
    this.name = 'SchemaMismatchError';
    this.dbPath = dbPath;
    this.details = details;
  }
}

/** Source db failed integrity_check / foreign_key_check or data validation. */
export class SourceDbCorruptionError extends Error {
  readonly details: string;
  constructor(details: string) {
    super(`Source database is not migratable: ${details}`);
    this.name = 'SourceDbCorruptionError';
    this.details = details;
  }
}

/**
 * A forward migration failed mid-apply. Its transaction (SQL + user_version
 * stamp) rolled back as a unit; the db sits at the pre-migration version.
 */
export class ForwardMigrationError extends Error {
  readonly version: number;
  constructor(version: number, cause: unknown) {
    super(
      `Forward migration to v${version} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'ForwardMigrationError';
    this.version = version;
  }
}

/**
 * A forward migration carries the `-- requires_confirmation: true` marker and
 * must not be applied silently. Callers decide UX (M2+ daemon auto-apply
 * guard).
 */
export class DestructiveForwardMigrationError extends Error {
  readonly version: number;
  constructor(version: number) {
    super(
      `Forward migration to v${version} is marked destructive and requires explicit confirmation.`,
    );
    this.name = 'DestructiveForwardMigrationError';
    this.version = version;
  }
}

/** An id failed the UUID v4 format gate before touching a file path (R10). */
export class InvalidIdError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`Invalid id (not a lowercase UUID v4): ${JSON.stringify(id)}`);
    this.name = 'InvalidIdError';
    this.id = id;
  }
}

/** A reorder request whose anchors are absent, cross-playlist, or non-adjacent. */
export class InvalidReorderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReorderError';
  }
}

/** Entity lookup miss. */
export class NotFoundError extends Error {
  readonly entity: 'song' | 'playlist' | 'playlist_song';
  readonly id: string;
  constructor(entity: NotFoundError['entity'], id: string) {
    super(`${entity} not found: ${id}`);
    this.name = 'NotFoundError';
    this.entity = entity;
    this.id = id;
  }
}

/** source_* fields violate the invariant (M1-8/T4) — pair half-set, empty-string key, unknown provider, bad key syntax. */
export class InvalidSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSourceError';
  }
}

/** (source_provider, source_key) already belongs to another song (R12/R23). */
export class SourceKeyConflictError extends Error {
  readonly conflictingSongId: string;
  readonly provider: string;
  readonly key: string;
  constructor(conflictingSongId: string, provider: string, key: string) {
    super(`(${provider}, ${key}) already belongs to song ${conflictingSongId}`);
    this.name = 'SourceKeyConflictError';
    this.conflictingSongId = conflictingSongId;
    this.provider = provider;
    this.key = key;
  }
}

// ─── Download pipeline errors (M3-11) ──────────────────
//
// These carry their own wire `code`, so a failing task and a failing HTTP
// request report the SAME string without the two sides agreeing on a table:
// the daemon maps `code → status`, and the engine copies `code` straight onto
// `task.error_code`. The five classes above predate this and keep their
// hard-coded mapping in the daemon — only M3's new classes are coded.
//
// `code` stays in core, `status` stays in the daemon: core has no business
// knowing about HTTP.

export abstract class CodedError extends Error {
  abstract readonly code: string;
}

/** No usable LLM in either lark's config or aviary's, for an operation that needs one. */
export class LlmNotConfiguredError extends CodedError {
  readonly code = 'LLM_NOT_CONFIGURED';
  constructor(
    message = 'no LLM is configured (set llm.url and llm.model in lark or aviary config)',
  ) {
    super(message);
    this.name = 'LlmNotConfiguredError';
  }
}

/** The LLM was reachable-ish but the call failed: non-2xx, non-JSON, empty completion. */
export class LlmRequestError extends CodedError {
  readonly code = 'LLM_FAILED';
  constructor(message: string, options?: ErrorOptions) {
    super(`LLM request failed: ${message}`, options);
    this.name = 'LlmRequestError';
  }
}

/** bilibili answered, but with a non-zero envelope code or an unusable shape. */
export class BilibiliApiError extends CodedError {
  readonly code = 'BILIBILI_FAILED';
  readonly apiCode: number | null;
  constructor(message: string, apiCode: number | null = null) {
    super(message);
    this.name = 'BilibiliApiError';
    this.apiCode = apiCode;
  }
}

/**
 * Risk control: an HTML interception page under HTTP 200, or envelope -412.
 * Split from BilibiliApiError because the user-facing answer is different —
 * "try again later / this endpoint needs a signature", not "bad request".
 */
export class BilibiliRiskControlError extends CodedError {
  readonly code = 'BILIBILI_RISK_CONTROL';
  constructor(message: string) {
    super(message);
    this.name = 'BilibiliRiskControlError';
  }
}

/** The stored source key no longer resolves and no LLM is available to re-identify it. */
export class SourceGoneError extends CodedError {
  readonly code = 'SOURCE_GONE';
  constructor(message: string) {
    super(message);
    this.name = 'SourceGoneError';
  }
}

/** A URL is shaped right but could not be normalised online (b23 expansion, p→cid). */
export class NormalizeFailedError extends CodedError {
  readonly code = 'NORMALIZE_FAILED';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NormalizeFailedError';
  }
}

/** Pre-enqueue network checks blew the per-request budget (M3-5). */
export class PreflightTimeoutError extends CodedError {
  readonly code = 'PREFLIGHT_TIMEOUT';
  constructor(message = 'pre-enqueue checks timed out') {
    super(message);
    this.name = 'PreflightTimeoutError';
  }
}

/** ffmpeg / ffprobe failed, timed out, or produced nothing usable. */
export class FfmpegError extends CodedError {
  readonly code = 'FFMPEG_FAILED';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FfmpegError';
  }
}

/**
 * There is no usable ffmpeg/ffprobe on this machine (M7-18).
 *
 * Distinct from `FfmpegError` on purpose: that one means "the tools ran and
 * rejected this file", which is about the media. This one means the tools are
 * absent or unfit before any file is involved, which is about the machine — the
 * user installs something, or fixes a broken app bundle. Both download and
 * import raise it, so neither can degrade a missing toolchain into "this song
 * failed".
 */
export class MediaToolsUnavailableError extends CodedError {
  readonly code = 'MEDIA_TOOLS_UNAVAILABLE';
  /** `missing` = not on disk; `incompatible` = there, but cannot do the job. */
  readonly state: 'missing' | 'incompatible';
  constructor(state: 'missing' | 'incompatible', detail: string) {
    super(
      state === 'missing'
        ? `没有找到可用的 ffmpeg：${detail}。用 \`brew install ffmpeg\` 安装后重试。`
        : `ffmpeg 不可用：${detail}`,
    );
    this.name = 'MediaToolsUnavailableError';
    this.state = state;
  }
}

/**
 * The file landed but the database transaction did not (M3-7). Everything is
 * rolled back before this is thrown: the new file is gone and any previous
 * file is back in place.
 */
export class DownloadCommitError extends CodedError {
  readonly code = 'DOWNLOAD_COMMIT_FAILED';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DownloadCommitError';
  }
}

/** No such task id — never queued, or aged out of the terminal ring. */
export class TaskNotFoundError extends CodedError {
  readonly code = 'TASK_NOT_FOUND';
  constructor(taskId: string) {
    super(`task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

/** Cancel arrived after the irreversible commit point (`saving`, M3-5). */
export class TaskNotCancellableError extends CodedError {
  readonly code = 'TASK_NOT_CANCELLABLE';
  constructor(taskId: string, stage: string) {
    super(`task ${taskId} is past the point of no return (stage: ${stage})`);
    this.name = 'TaskNotCancellableError';
  }
}

/** Another writer holds a conflicting claim on this song's files (M3-7). */
export class SongBusyError extends CodedError {
  readonly code = 'SONG_BUSY';
  readonly songId: string;
  constructor(songId: string, held: string) {
    super(`song ${songId} is busy (${held})`);
    this.name = 'SongBusyError';
    this.songId = songId;
  }
}

/** Pending (queued + running) tasks are at capacity (M3-5). */
export class DownloadQueueFullError extends CodedError {
  readonly code = 'DOWNLOAD_QUEUE_FULL';
  constructor(capacity: number) {
    super(`download queue is full (${capacity} pending tasks); wait for some to finish`);
    this.name = 'DownloadQueueFullError';
  }
}

// ─── Playlist transfer errors (M5-13) ──────────────────
//
// Coded like M3's, and for the same reason the dependency guard demands it:
// core cannot reach for the daemon's `InvalidRequestError`, so the file's
// verdict travels as a code the daemon maps to 400.

/** The file says `version: N` and this build only understands version 1. */
export class UnsupportedFormatVersionError extends CodedError {
  readonly code = 'UNSUPPORTED_FORMAT_VERSION';
  readonly version: unknown;
  constructor(version: unknown, supported: number) {
    super(`导入文件的版本是 ${JSON.stringify(version)}，当前版本只支持 ${supported}——请升级 lark`);
    this.name = 'UnsupportedFormatVersionError';
    this.version = version;
  }
}

/** Not JSON, not a lark playlist file, or a song entry that fails validation. */
export class InvalidImportFileError extends CodedError {
  readonly code = 'INVALID_IMPORT_FILE';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidImportFileError';
  }
}

/**
 * A `reuse` instruction the commit re-validation refused: the song is gone, it
 * is not one of that entry's candidates, or the entry already matched by key
 * (a key hit always wins, R12).
 */
export class InvalidReuseError extends CodedError {
  readonly code = 'INVALID_REUSE';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReuseError';
  }
}
