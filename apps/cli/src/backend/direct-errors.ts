// core error → CLI code (M6-5, §4.1).
//
// The daemon has a status table for the same classes; this is the exit-code
// half of it, and the two are kept in step by the parity tests: a condition
// that answers `NOT_FOUND` over HTTP has to answer `NOT_FOUND` in-process, or
// `--direct` becomes a different product with the same command names.
//
// Matched by CLASS NAME rather than `instanceof`, because the classes arrive
// from a DYNAMIC import of `@lark/core` (M6-21) — the module object is not the
// one a static import would have given us, and `instanceof` across the two
// would be a coin toss. Every class sets `this.name` in its constructor, so
// the name is as reliable as the identity and does not pin the module graph.

import { CliError } from '../lib/errors.js';
import { type CliErrorCode, isCliErrorCode } from '../lib/exit-codes.js';

const CODE_BY_ERROR_NAME: Record<string, CliErrorCode> = {
  // Library operations.
  NotFoundError: 'NOT_FOUND',
  InvalidIdError: 'INVALID_ID',
  InvalidSourceError: 'INVALID_SOURCE',
  SourceKeyConflictError: 'SOURCE_KEY_CONFLICT',
  SongBusyError: 'SONG_BUSY',
  InvalidReorderError: 'INVALID_REORDER',

  // Playlist transfer.
  UnsupportedFormatVersionError: 'UNSUPPORTED_FORMAT_VERSION',
  InvalidImportFileError: 'INVALID_IMPORT_FILE',
  InvalidReuseError: 'INVALID_REUSE',

  // Opening the library (M6-20) and taking the writer lock (M6-18).
  DatabaseNotInitializedError: 'DB_NOT_INITIALIZED',
  GoMigrationRequiredError: 'MIGRATION_REQUIRED',
  MigrationPendingError: 'MIGRATION_PENDING',
  MigrationBusyError: 'MIGRATION_BUSY',
  IncompatibleDbError: 'INCOMPATIBLE_DB',
  SchemaMismatchError: 'SCHEMA_MISMATCH',
  MigrationResidueError: 'MIGRATION_RESIDUE',
  ForwardMigrationError: 'MIGRATION_FAILED',
  DestructiveForwardMigrationError: 'MIGRATION_FAILED',
  SourceDbCorruptionError: 'MIGRATION_FAILED',
  WriterLockBusyError: 'WRITER_BUSY',
  ConfigUnsafePermissionsError: 'CONFIG_UNSAFE_PERMISSIONS',
};

/** Extra fields the HTTP side puts in `details`, kept identical here. */
function detailsFor(err: Error): Record<string, unknown> | undefined {
  const anyErr = err as unknown as Record<string, unknown>;
  if (err.name === 'SourceKeyConflictError') {
    return { conflicting_song_id: anyErr.conflictingSongId };
  }
  if (err.name === 'SongBusyError') return { song_id: anyErr.songId };
  return undefined;
}

/**
 * Translate a core error into the CliError the command layer expects.
 *
 * Anything unrecognised keeps its message and lands on `UNKNOWN` — a generic
 * failure with the original text beats a confident wrong code.
 */
export function toDirectCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (!(err instanceof Error)) return new CliError('UNKNOWN', String(err));

  const mapped = CODE_BY_ERROR_NAME[err.name];
  if (mapped !== undefined) {
    const details = detailsFor(err);
    return new CliError(mapped, err.message, details);
  }

  // M3's coded errors carry their own wire code (`FFMPEG_FAILED`, …), which is
  // already the code the HTTP side would have sent.
  const code = (err as unknown as { code?: unknown }).code;
  if (typeof code === 'string' && isCliErrorCode(code)) return new CliError(code, err.message);

  return new CliError('UNKNOWN', err.message);
}
