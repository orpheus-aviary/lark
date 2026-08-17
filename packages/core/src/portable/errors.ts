// The three error classes the portable modules throw (N0a, decision i).
//
// They live here rather than in `../errors.ts` for a boring reason: the
// portable guard forbids reaching back into core, and `migrate.ts` /
// `schema-signature.ts` throw these at runtime — a type-only import would not
// have been enough.
//
// `../errors.ts` re-exports all three, so both ways daemon and CLI consume
// them keep working unchanged: `instanceof` (daemon/boot.ts) and `err.name`
// (the CLI's dynamic-import backend) both see the SAME class object, because
// re-export is not redefinition.
//
// Nothing else moved. The rest of core's errors stay put — these three are
// here because portable code throws them, not because they are special.

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
