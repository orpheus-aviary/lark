// The ONE definition of "the current schema" (T3; v1 → v2 in v0.2 T0, v2 → v3
// in 0.3.0). Three call sites share it — createDatabase's ==LATEST path, the
// read-only open, and the crash-recovery validation (the Go migration was a
// fourth until 0.3 deleted it). They must never drift into private ideas of
// the current schema: a db that lost its sync tables would pass a four-table
// check today and explode on the first login.
//
// The name used to carry the version (`assertSchemaV2`), so that bumping
// LATEST_KNOWN_VERSION broke every call site until somebody decided what the
// new signature was. Three versions in, that rename is churn across every
// caller which proves nothing on its own. What replaces it is stronger and
// automatic: `schema-signature.test.ts` migrates a database from zero and
// asserts this list names EVERY table the chain created — a migration that
// adds a table and forgets this file now fails there, without anyone having
// to remember a renaming ritual.

import { SchemaMismatchError } from './errors.js';
import type { SqliteLike } from './sqlite.js';

/** Exported for the completeness test, which is what keeps this list honest. */
export const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  songs: [
    'id',
    'name',
    'artist',
    'source_url',
    'source_provider',
    'source_key',
    'file_origin',
    'lyrics_offset',
    'duration',
    'pinned',
    'last_accessed_at',
    'created_at',
    'updated_at',
    'device_id',
    'lww_counter',
  ],
  playlists: ['id', 'name', 'created_at', 'updated_at', 'device_id', 'lww_counter'],
  playlist_songs: [
    'playlist_id',
    'song_id',
    'rank',
    'added_at',
    'updated_at',
    'device_id',
    'lww_counter',
  ],
  local_metadata: ['key', 'value'],
  sync_changes: [
    'local_seq',
    'device_id',
    'entity_type',
    'entity_id',
    'op',
    'payload',
    'created_at',
    'client_change_id',
    'server_seq',
    'synced_at',
  ],
  // v2: keyed by (server_id, workspace_id) — the v1 `endpoint` column is gone,
  // so a v1-shaped cursor table fails here rather than silently never matching.
  sync_cursor: ['server_id', 'workspace_id', 'pulled_seq', 'pushed_seq', 'updated_at'],
  sync_tombstones: [
    'entity_type',
    'entity_id',
    'updated_at',
    'lww_counter',
    'device_id',
    'deleted_at',
  ],
  sync_file_ops: [
    'id',
    'kind',
    'song_id',
    'arg',
    'created_at',
    'attempts',
    'last_error',
    'next_retry_at',
  ],
  sync_dead_letters: [
    'id',
    'direction',
    'server_seq',
    'client_change_id',
    'device_id',
    'entity_type',
    'entity_id',
    'op',
    'payload',
    'reason',
    'recorded_at',
  ],
  sync_binding: ['id', 'server_id', 'user_id', 'workspace_id', 'schema_version', 'bound_at'],
  // v3: the one-time audio migration's ledger. Keyed by the directory name
  // under songs/, not by song_id — see 0003.
  audio_migration: [
    'object_key',
    'song_id',
    'class',
    'file_origin',
    'source_key_present',
    'status',
    'blocked_action',
    'resume_state',
    'error_class',
    'last_error',
    'backup_path',
    'reconcile_action',
    'at',
  ],
  conflict_record: [
    'id',
    'entity_type',
    'entity_id',
    'local_seq',
    'remote_seq',
    'detected_at',
    'resolved_at',
    'resolution',
    'losing_side',
    'local_payload',
    'remote_payload',
    'local_updated_at_ms',
    'remote_updated_at_ms',
    // v2 (owl 0011): the rest of the LWW key, display-only.
    'local_lww_counter',
    'remote_lww_counter',
    'local_device_id',
    'remote_device_id',
  ],
};

/**
 * Load-bearing CHECK fingerprints, matched against normalized
 * `sqlite_master.sql`. The DDL is always our own migration text, so
 * whitespace-collapsed lowercase fragment matching is deterministic.
 *
 * Only constraints whose loss would be silently corrupting are listed: the
 * songs domains, and the singleton guard on sync_binding (a second binding row
 * would mean a library quietly serving two workspaces).
 */
const TABLE_CHECK_FRAGMENTS: Record<string, readonly string[]> = {
  songs: [
    "file_origin in ('downloaded','imported')",
    'pinned in (0,1)',
    '(source_provider is null) = (source_key is null)',
  ],
  sync_binding: ['check (id = 1)'],
};

interface IndexRequirement {
  readonly name: string;
  /** Normalized fragments the index's sqlite_master.sql must contain. */
  readonly fragments: readonly string[];
  /** Fragments it must NOT contain — a constraint removed on purpose. */
  readonly forbidden?: readonly string[];
}

/**
 * Definition-checked indexes. UNIQUE and partial WHERE clauses are verified
 * against sqlite_master.sql — a plain index smuggled in under the same name
 * must not pass, and neither must a UNIQUE one where v2 dropped uniqueness.
 */
const REQUIRED_INDEXES: readonly IndexRequirement[] = [
  {
    // v2: no longer UNIQUE (D8 — sync may legitimately deliver a duplicate
    // (provider, key), and a UNIQUE index would turn that into an apply that
    // can never succeed).
    name: 'idx_songs_source_key',
    fragments: ['create index', 'where source_provider is not null'],
    forbidden: ['unique'],
  },
  { name: 'idx_playlist_songs_song', fragments: ['create index'] },
  { name: 'idx_sync_changes_created', fragments: ['create index'] },
  { name: 'idx_sync_changes_cid', fragments: ['create unique index'] },
  { name: 'idx_sync_changes_pending', fragments: ['where synced_at is null'] },
  { name: 'idx_sync_changes_entity', fragments: ['create index'] },
  { name: 'idx_sync_file_ops_song', fragments: ['create index'] },
  { name: 'idx_sync_dead_letters_recent', fragments: ['create index'] },
  { name: 'idx_conflict_unresolved', fragments: ['where resolved_at is null'] },
  { name: 'idx_audio_migration_status', fragments: ['create index'] },
];

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase().trim();
}

function tableSql(sqlite: SqliteLike, table: string): string {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string | null } | undefined;
  return normalizeSql(row?.sql ?? '');
}

/**
 * Assert the connected database carries the current schema: every table above
 * with its required columns, the definition-relevant indexes (UNIQUE / partial
 * WHERE verified, not just the name), and the load-bearing CHECKs.
 * Throws SchemaMismatchError with the first discrepancy.
 */
export function assertCurrentSchema(sqlite: SqliteLike, dbPath: string): void {
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const info = sqlite.pragma(`table_info(${table})`) as { name: string }[];
    if (info.length === 0) {
      throw new SchemaMismatchError(dbPath, `table '${table}' is missing`);
    }
    const present = new Set(info.map((c) => c.name));
    for (const col of cols) {
      if (!present.has(col)) {
        throw new SchemaMismatchError(dbPath, `table '${table}' missing required column '${col}'`);
      }
    }
  }

  for (const [table, fragments] of Object.entries(TABLE_CHECK_FRAGMENTS)) {
    const sql = tableSql(sqlite, table);
    for (const fragment of fragments) {
      if (!sql.includes(fragment)) {
        throw new SchemaMismatchError(dbPath, `${table} table lost its CHECK: ${fragment}`);
      }
    }
  }

  for (const req of REQUIRED_INDEXES) {
    const row = sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
      .get(req.name) as { sql: string | null } | undefined;
    if (!row) {
      throw new SchemaMismatchError(dbPath, `index '${req.name}' is missing`);
    }
    const indexSql = normalizeSql(row.sql ?? '');
    for (const fragment of req.fragments) {
      if (!indexSql.includes(fragment)) {
        throw new SchemaMismatchError(
          dbPath,
          `index '${req.name}' does not match its v2 definition (missing: ${fragment})`,
        );
      }
    }
    for (const fragment of req.forbidden ?? []) {
      if (indexSql.includes(fragment)) {
        throw new SchemaMismatchError(
          dbPath,
          `index '${req.name}' does not match its v2 definition (unexpected: ${fragment})`,
        );
      }
    }
  }
}
