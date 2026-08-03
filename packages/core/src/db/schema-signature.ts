// The ONE definition of "a valid schema v1" (T3). Three call sites share it —
// createDatabase's ==LATEST path, the Go migration's already-migrated
// short-circuit, and the pre-swap acceptance on the freshly built temp db
// (plus the main+old-swap crash-recovery validation). They must never drift
// into three private ideas of v1: a db that lost its sync tables would pass a
// four-table check today and explode in v0.2.

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
  sync_cursor: ['endpoint', 'pulled_seq', 'pushed_seq', 'updated_at'],
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
  ],
};

/**
 * Key CHECK fingerprints on the songs table, matched against normalized
 * `sqlite_master.sql`. The DDL is always our own 0001 text, so
 * whitespace-collapsed lowercase fragment matching is deterministic.
 */
const SONGS_CHECK_FRAGMENTS: readonly string[] = [
  "file_origin in ('downloaded','imported')",
  'pinned in (0,1)',
  '(source_provider is null) = (source_key is null)',
];

interface IndexRequirement {
  readonly name: string;
  /** Normalized fragments the index's sqlite_master.sql must contain. */
  readonly fragments: readonly string[];
}

/**
 * Definition-checked indexes. UNIQUE and partial WHERE clauses are verified
 * against sqlite_master.sql — a plain index smuggled in under the same name
 * must not pass.
 */
const REQUIRED_INDEXES: readonly IndexRequirement[] = [
  {
    name: 'idx_songs_source_key',
    fragments: ['create unique index', 'where source_provider is not null'],
  },
  { name: 'idx_playlist_songs_song', fragments: ['create index'] },
  { name: 'idx_sync_changes_created', fragments: ['create index'] },
  { name: 'idx_sync_changes_cid', fragments: ['create unique index'] },
  { name: 'idx_sync_changes_pending', fragments: ['where synced_at is null'] },
  { name: 'idx_conflict_unresolved', fragments: ['where resolved_at is null'] },
];

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase().trim();
}

/**
 * Assert the connected database carries the full schema v1: all 7 tables with
 * their required columns, the definition-relevant indexes (UNIQUE / partial
 * WHERE verified, not just the name), and the three key CHECKs on songs.
 * Throws SchemaMismatchError with the first discrepancy.
 */
export function assertSchemaV1(sqlite: BetterSqlite3.Database, dbPath: string): void {
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

  const songsSqlRow = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='songs'")
    .get() as { sql: string } | undefined;
  const songsSql = normalizeSql(songsSqlRow?.sql ?? '');
  for (const fragment of SONGS_CHECK_FRAGMENTS) {
    if (!songsSql.includes(fragment)) {
      throw new SchemaMismatchError(dbPath, `songs table lost its CHECK: ${fragment}`);
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
          `index '${req.name}' does not match its v1 definition (missing: ${fragment})`,
        );
      }
    }
  }
}
