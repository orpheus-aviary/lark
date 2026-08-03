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
