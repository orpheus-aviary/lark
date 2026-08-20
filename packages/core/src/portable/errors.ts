// Structured error types (T3), the whole vocabulary (N1a).
//
// daemon / CLI / GUI render UX by instanceof + fields — never by parsing
// message strings. All of them are re-exported from `../errors.ts` and from the
// core barrel, so every existing consumer keeps seeing the SAME class objects
// it always did: `instanceof` in the daemon, `err.name` in the CLI's
// dynamic-import backend. Re-export is not redefinition.
//
// They live here rather than in core proper because portable code throws them:
// `migrate.ts` threw three of them from N0a on, and N1 moves sync / library /
// the download client layer in behind them. Splitting the file by "which ones
// does portable throw today" would be a line nobody could keep — a desktop-only
// error and a portable one are the same kind of object, and the set that
// portable throws grows every batch.
//
// Nothing here may reach for a host: no Node builtins, no `Buffer`, no errno
// types. `scripts/check-core-portable.sh` enforces it.

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

/**
 * createDatabase found the Go-era songs.db (user_version=0, non-empty,
 * playlists.is_system present).
 *
 * The refusal outlives the migration that used to answer it: 0.3 deleted the
 * Go importer (nobody has run it since the one library it was written for
 * moved over, and it was a dev-checkout command to begin with). Recognising
 * the shape still matters — without it the library reads as "unknown v0
 * schema", which is the same refusal with none of the guidance.
 */
export class GoMigrationRequiredError extends Error {
  readonly dbPath: string;
  constructor(dbPath: string) {
    super(
      `Database at ${dbPath} is a Go-version lark library. This build cannot migrate it — lark 0.3 removed the importer. Migrate with a lark 0.2.x checkout (\`just migrate-go\`) first, then upgrade.`,
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

/**
 * The db is at a version this host CAN forward-migrate in principle, and
 * refuses to (N2b, decision m).
 *
 * Deliberately not `IncompatibleDbError`: that one means "I do not recognise
 * this", and its message tells you to upgrade the app — advice that is exactly
 * backwards for a library that is too OLD. The Android client refuses v1/v2
 * because it has none of the desktop's migration safety net (the writer lock,
 * the backup-and-swap, the mp3 scan), and because such a library cannot arise
 * there naturally — only from a restore or a file copy.
 */
export class ForwardMigrationUnsupportedError extends Error {
  readonly dbPath: string;
  readonly dbVersion: number;
  constructor(dbPath: string, dbVersion: number) {
    super(
      `Database at ${dbPath} is at v${dbVersion}, from an older lark. This client does not migrate libraries — open it with the desktop app to bring it up to date.`,
    );
    this.name = 'ForwardMigrationUnsupportedError';
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
      `Database at ${dbPath} is at v${dbVersion} and this build expects v${target}. Start the daemon once (\`lark daemon\`) to complete the upgrade, then retry. From v3 that upgrade also runs the one-time mp3 → m4a conversion, so give it time to finish.`,
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

/** Source db failed integrity_check / foreign_key_check or data validation. */
export class SourceDbCorruptionError extends Error {
  readonly details: string;
  constructor(details: string) {
    super(`Source database is not migratable: ${details}`);
    this.name = 'SourceDbCorruptionError';
    this.details = details;
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

/**
 * A stream that is not AAC reached a host that cannot transcode (D17, N4b).
 *
 * The desktop transcodes anything ffmpeg can read; the phone stores bilibili's
 * fMP4 as it arrives and has no encoder, so a non-AAC stream is refused BEFORE
 * a byte is downloaded (§1.7). Deliberately NOT a `CodedError`: the daemon
 * never raises it (it transcodes), so the condition is task-only — it lands on
 * a download task's `error_code` as `AUDIO_NOT_AAC` via `describeTaskError`, and
 * never on a response envelope. Mobile-only, and the only place D17's
 * refuse-half was ever going to live.
 */
export class AudioNotAacError extends Error {
  constructor(message = '这个来源没有 AAC 音频流，而这台设备只能保存 AAC（手机上不做转码）。') {
    super(message);
    this.name = 'AudioNotAacError';
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

/**
 * An emit would have produced a change too large to push (§3.9).
 *
 * Raised at EMIT time, never at push time: a change the server would refuse
 * must not enter the outbox at all, or it parks at the head of the queue and
 * nothing behind it ever syncs again. Only lyrics can realistically hit it,
 * and that path catches this and records an outbound dead letter instead —
 * the song stays correct locally and stops being a sync convergence point.
 */
export class SyncChangeTooLargeError extends Error {
  readonly entityType: string;
  readonly entityId: string;
  readonly op: string;
  readonly bytes: number;
  readonly limit: number;
  constructor(entityType: string, entityId: string, op: string, bytes: number, limit: number) {
    super(`${entityType}.${op} change is ${bytes} bytes, over the ${limit} byte sync limit`);
    this.name = 'SyncChangeTooLargeError';
    this.entityType = entityType;
    this.entityId = entityId;
    this.op = op;
    this.bytes = bytes;
    this.limit = limit;
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

/** Why a value the library service was handed is not usable (N1g). */
export type LibraryInputReason = 'required' | 'too_long' | 'too_many' | 'out_of_range';

/**
 * A caller broke one of the library's own input rules (N1g).
 *
 * Trim-then-require-then-cap, the id gate, the list ceilings: rules that are
 * the LIBRARY's, not any one front end's, and that used to be written out
 * separately in the daemon's request validator and the CLI's direct backend.
 * They agreed until they didn't — `--direct` checked a name's length but not
 * whether it was blank, so `' 稻香 '` and `'稻香'` were two different songs
 * over HTTP and one song in process (§7 F13).
 *
 * It carries `field` and `reason` rather than only a sentence because each
 * front end still speaks its own vocabulary: the daemon has to answer
 * `INVALID_BODY` for a name and `INVALID_QUERY` for a search term, and the CLI
 * has to answer `USAGE_ERROR` for both. The message here is the one a PERSON
 * reads at a terminal.
 *
 * Deliberately NOT a `CodedError`: that base class means "carries the wire
 * code a client will receive", and the whole point of this one is that the
 * library has no opinion about which code a front end owes its caller.
 */
export class LibraryInputError extends Error {
  readonly field: string;
  readonly reason: LibraryInputReason;
  /** The ceiling that was exceeded, for `too_long` / `too_many`. */
  readonly limit?: number;
  constructor(field: string, reason: LibraryInputReason, message: string, limit?: number) {
    super(message);
    this.name = 'LibraryInputError';
    this.field = field;
    this.reason = reason;
    if (limit !== undefined) this.limit = limit;
  }
}

/**
 * A write aimed at the virtual all-songs playlist (R3/R24).
 *
 * `all` is a view synthesised by the read paths; it has no row, so a write
 * against it cannot be a no-op — that would silently drop a user's edit and
 * leave a front-end bug invisible.
 */
export class VirtualPlaylistError extends Error {
  constructor(message = '「all」是虚拟歌单，不能写入。') {
    super(message);
    this.name = 'VirtualPlaylistError';
  }
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

/**
 * The same video is already queued under the other naming mode (0.3.0 §3.6-1).
 *
 * Two requests for one video merge onto ONE task — that is what stops a
 * double-click downloading twice — so the second submitter would silently
 * receive the first one's naming. Refusing is the only answer that does not
 * misreport what happened: the queue is not a place where the last writer
 * wins, and there is nothing to reconcile.
 */
export class NamingModeConflictError extends CodedError {
  readonly code = 'NAMING_MODE_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'NamingModeConflictError';
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

// ─── sync file-effect journal (v0.2 §3.6) ──────────────

/** The journal row named by a retry / discard request is not there. */
export class FileOpNotFoundError extends CodedError {
  readonly code = 'FILE_OP_NOT_FOUND';
  constructor(id: number) {
    super(`file op ${id} not found`);
    this.name = 'FileOpNotFoundError';
  }
}

/**
 * A file op cannot be retried or discarded right now.
 *
 * Two cases, one answer: the runtime is executing (so the row's state is about
 * to change under the caller), or the row has not failed permanently yet (so
 * discarding it would abandon work that is still going to run). Both are "ask
 * again later", never "this is impossible".
 */
export class FileOpBusyError extends CodedError {
  readonly code = 'FILE_OP_BUSY';
  constructor(message: string) {
    super(message);
    this.name = 'FileOpBusyError';
  }
}

/**
 * Two songs hold the same `(source_provider, source_key)` (D8).
 *
 * Only sync can produce this: local paths still refuse to create a duplicate,
 * but two offline devices can each download the same video, and no merge of
 * the pair is safe regardless of which arrives first. So both are kept, made
 * visible, and every by-key lookup says so rather than picking one — the user
 * deletes one and everything downstream resolves again.
 */
export class AmbiguousSourceKeyError extends CodedError {
  readonly code = 'AMBIGUOUS_SOURCE_KEY';
  readonly provider: string;
  readonly key: string;
  readonly songIds: readonly string[];
  // `songIds` defaults so the class survives the registry test's two-spare-
  // strings probe, like every other coded error.
  constructor(provider: string, key: string, songIds: readonly string[] = []) {
    super(
      `(${provider}, ${key}) belongs to ${songIds.length} songs (${songIds.join(', ')}) — delete the duplicate you do not want to keep`,
    );
    this.name = 'AmbiguousSourceKeyError';
    this.provider = provider;
    this.key = key;
    this.songIds = songIds;
  }
}

/**
 * A conflict resolve arrived with a stale `expected_current`.
 *
 * Between seeing a conflict and answering it, a third device can write again.
 * Restoring the local copy over THAT would undo a change the user never saw,
 * so the answer is refused and they get to decide once more against what the
 * row actually holds now.
 */
export class ConflictVersionMismatchError extends CodedError {
  readonly code = 'CONFLICT_VERSION_MISMATCH';
  constructor(message: string) {
    super(message);
    this.name = 'ConflictVersionMismatchError';
  }
}

/** The conflict id in the request does not name a record. */
/**
 * "Keep mine" on a conflict whose local copy was never recorded (§7 F3).
 *
 * Not a version mismatch and not a missing conflict: the record is there and
 * current, it just has nothing to restore FROM. Answering anything else would
 * send the caller back to reload a record that will say the same thing.
 */
export class ConflictPayloadUnavailableError extends CodedError {
  readonly code = 'CONFLICT_PAYLOAD_UNAVAILABLE';
  constructor(message = '这条冲突没有保存本机版本，无法「保留本机」——只能保留远端版本') {
    super(message);
    this.name = 'ConflictPayloadUnavailableError';
  }
}

export class ConflictNotFoundError extends CodedError {
  readonly code = 'CONFLICT_NOT_FOUND';
  constructor(id: string) {
    super(`conflict ${id} not found`);
    this.name = 'ConflictNotFoundError';
  }
}

// ─── skybridge session and binding (v0.2 §3.7 / §3.11) ──

/**
 * Sync was asked to do something that needs a session, and there is none.
 *
 * A STATE, not a fault: the daemon keeps serving the library, and the only
 * thing that changes is that nothing syncs until the user logs in. Which is
 * also why it must never surface as HTTP 401 — that status already means "your
 * daemon token is wrong" to every client lark ships.
 */
export class SyncAuthRequiredError extends CodedError {
  readonly code = 'SYNC_AUTH_REQUIRED';
  constructor(message = 'sync is not logged in — run `lark sync login` first') {
    super(message);
    this.name = 'SyncAuthRequiredError';
  }
}

/**
 * This library is already bound to a different server / user / workspace.
 *
 * The binding row is written once and never updated (§3.7). Letting a second
 * workspace adopt a bound library would mix two change histories under one set
 * of entity ids, and no amount of later cleanup can separate them again — so
 * the answer is to refuse, and `lark sync unbind` is the deliberate way out.
 */
export class SyncBindingMismatchError extends CodedError {
  readonly code = 'SYNC_BINDING_MISMATCH';
  readonly field: string;
  constructor(field: string, expected: string, actual: string) {
    super(
      `this library is bound to a different workspace (${field}: bound to ${expected}, asked for ${actual}) — run \`lark sync unbind\` if you really mean to move it`,
    );
    this.name = 'SyncBindingMismatchError';
    this.field = field;
  }
}

/** The workspace speaks a protocol version this build does not (§3.7 schema gate). */
export class SyncSchemaVersionMismatchError extends CodedError {
  readonly code = 'SYNC_SCHEMA_VERSION_MISMATCH';
  readonly expected: number;
  readonly actual: number;
  constructor(expected = 0, actual = 0) {
    super(
      `the workspace speaks sync schema v${actual}, this build speaks v${expected} — upgrade the older side before syncing`,
    );
    this.name = 'SyncSchemaVersionMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * The server URL is plaintext http and nobody flipped the breaker.
 *
 * A login sends a password, so the default is closed. Loopback is exempt (it
 * never leaves the machine); anything else needs `allow_insecure_http`, which
 * both front-ends confirm twice before it gets here.
 */
export class SyncInsecureUrlError extends CodedError {
  readonly code = 'SYNC_INSECURE_URL';
  constructor(message: string) {
    super(message);
    this.name = 'SyncInsecureUrlError';
  }
}

/** The sync server could not be reached, or answered in a way retrying might fix. */
export class SyncUnavailableError extends CodedError {
  readonly code = 'SYNC_UNAVAILABLE';
  readonly status: number | null;
  constructor(message: string, status: number | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SyncUnavailableError';
    this.status = status;
  }
}

/**
 * `unbind` refused because this device still holds unsynced work (R5-P1-3).
 *
 * The dangerous rows are the ones that express themselves by ABSENCE — an
 * unpushed song/membership delete, a `clear_lyrics`. Unbind drops the outbox
 * and the tombstones, and the full backfill that runs on the next login can
 * only republish what still exists; the workspace's old `create` would then
 * bring the deleted thing back. Push first, or say `--force` and accept it.
 */
export class SyncPendingChangesError extends CodedError {
  readonly code = 'SYNC_PENDING_CHANGES';
  readonly pending: number;
  readonly unpublishedDeletes: number;
  constructor(pending = 0, unpublishedDeletes = 0) {
    super(
      `${pending} local changes have not been pushed yet (${unpublishedDeletes} of them are deletions that cannot be republished) — run \`lark sync run\` first, or pass --force to discard them`,
    );
    this.name = 'SyncPendingChangesError';
    this.pending = pending;
    this.unpublishedDeletes = unpublishedDeletes;
  }
}
