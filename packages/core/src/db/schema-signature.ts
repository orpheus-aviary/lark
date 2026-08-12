// The ONE definition of "a valid schema v2" (T3, raised from v1 in v0.2 T0).
// Four call sites share it — createDatabase's ==LATEST path, the read-only
// open, the crash-recovery validation, and the Go migration (already-migrated
// short-circuit + pre-swap acceptance on the freshly built temp db). They must
// never drift into four private ideas of the current schema: a db that lost
// its sync tables would pass a four-table check today and explode on the first
// login.
//
// The name carries the version on purpose. Bumping LATEST_KNOWN_VERSION should
// break every call site until somebody has decided what the new signature is.

import type BetterSqlite3 from 'better-sqlite3';
import { SchemaMismatchError } from '../errors.js';

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
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
];

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase().trim();
}

function tableSql(sqlite: BetterSqlite3.Database, table: string): string {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string | null } | undefined;
  return normalizeSql(row?.sql ?? '');
}

/**
 * Assert the connected database carries the full schema v2: all 11 tables with
 * their required columns, the definition-relevant indexes (UNIQUE / partial
 * WHERE verified, not just the name), and the load-bearing CHECKs.
 * Throws SchemaMismatchError with the first discrepancy.
 */
export function assertSchemaV2(sqlite: BetterSqlite3.Database, dbPath: string): void {
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
