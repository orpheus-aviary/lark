// The migration chain, end to end, on whatever host is running.
//
// This is the group that makes the whole exercise worth it: the Android client
// does not get its own schema builder, it runs THESE migrations. If 0001→0003
// produces a different database over there, everything downstream is a guess.

import {
  LATEST_KNOWN_VERSION,
  applyForwardMigrations,
  assertNotDestructive,
} from '../../migrate.js';
import { MIGRATIONS, type Migration } from '../../migrations/index.js';
import {
  AUDIO_MIGRATION_PENDING_KEY,
  clearAudioMigrationPending,
  isAudioMigrationPending,
} from '../../pending.js';
import { REQUIRED_COLUMNS, assertCurrentSchema } from '../../schema-signature.js';
import type { SqliteLike } from '../../sqlite.js';
import { check, equal, throws } from '../assert.js';
import type { ContractCase } from '../types.js';
import { count, migrate, scalar } from './support.js';

const GROUP = 'migrations';

const DB_PATH = 'contract.db';

function userTables(sqlite: SqliteLike): string[] {
  const rows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return rows.map((r) => r.name).sort();
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : String(err);
}

export const MIGRATION_CASES: readonly ContractCase[] = [
  {
    group: GROUP,
    name: 'the chain runs from zero to LATEST_KNOWN_VERSION',
    run(db) {
      const sqlite = db.sqlite;
      equal(sqlite.pragma('user_version', { simple: true }), 0, 'starts empty');
      applyForwardMigrations(sqlite, 0, LATEST_KNOWN_VERSION);
      equal(
        sqlite.pragma('user_version', { simple: true }),
        LATEST_KNOWN_VERSION,
        'ends at LATEST',
      );
      equal(MIGRATIONS.length, LATEST_KNOWN_VERSION, 'the registry is contiguous from 1');
    },
  },
  {
    group: GROUP,
    name: 'assertCurrentSchema passes on a freshly migrated database',
    run(db) {
      const sqlite = migrate(db.sqlite);
      assertCurrentSchema(sqlite, DB_PATH);
    },
  },
  {
    group: GROUP,
    name: 'REQUIRED_COLUMNS names every table the chain created',
    run(db) {
      // The signature's own safety net: a migration that adds a table and
      // forgets the signature fails HERE, not on the day something drops it.
      const sqlite = migrate(db.sqlite);
      const created = userTables(sqlite);
      const named = Object.keys(REQUIRED_COLUMNS).sort();
      for (const table of created) {
        check(named.includes(table), `REQUIRED_COLUMNS is missing the table '${table}'`);
      }
      for (const table of named) {
        check(
          created.includes(table),
          `REQUIRED_COLUMNS names '${table}', which the chain never created`,
        );
      }
    },
  },
  {
    group: GROUP,
    name: 'assertCurrentSchema refuses a database missing a table',
    run(db) {
      const sqlite = migrate(db.sqlite);
      sqlite.exec('DROP TABLE conflict_record');
      const err = throws(() => assertCurrentSchema(sqlite, DB_PATH), 'a dropped table');
      equal(errorName(err), 'SchemaMismatchError', 'the error class');
    },
  },
  {
    group: GROUP,
    name: 'assertCurrentSchema refuses a database missing a column',
    run(db) {
      const sqlite = migrate(db.sqlite);
      sqlite.exec('ALTER TABLE songs DROP COLUMN lww_counter');
      const err = throws(() => assertCurrentSchema(sqlite, DB_PATH), 'a dropped column');
      equal(errorName(err), 'SchemaMismatchError', 'the error class');
    },
  },
  {
    group: GROUP,
    name: 'assertCurrentSchema refuses an index that lost its partial WHERE',
    run(db) {
      const sqlite = migrate(db.sqlite);
      sqlite.exec(
        `DROP INDEX idx_sync_changes_pending;
         CREATE INDEX idx_sync_changes_pending ON sync_changes(synced_at);`,
      );
      const err = throws(() => assertCurrentSchema(sqlite, DB_PATH), 'a widened index');
      equal(errorName(err), 'SchemaMismatchError', 'the error class');
    },
  },
  {
    group: GROUP,
    name: 'a failing migration rolls back its SQL and its version stamp',
    run(db) {
      // Fail-closed is the whole design: the `PRAGMA user_version = N` stamp
      // commits in the SAME transaction as the DDL, so a half-applied schema
      // can never sit there wearing the new number.
      const sqlite = db.sqlite;
      const good: Migration = { version: 1, sql: 'CREATE TABLE ok (id TEXT PRIMARY KEY);' };
      const bad: Migration = {
        version: 2,
        sql: 'CREATE TABLE half (id TEXT PRIMARY KEY); CREATE TABLE half (id TEXT PRIMARY KEY);',
      };

      const err = throws(
        () => applyForwardMigrations(sqlite, 0, 2, [good, bad]),
        'a migration whose SQL fails halfway',
      );
      equal(errorName(err), 'ForwardMigrationError', 'the error class');
      equal(sqlite.pragma('user_version', { simple: true }), 1, 'stopped at the last good version');
      equal(
        count(sqlite, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'ok'"),
        1,
        'v1 kept',
      );
      equal(
        count(sqlite, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'half'"),
        0,
        'the half-applied table is gone',
      );
    },
  },
  {
    group: GROUP,
    name: 'a migration marked destructive is refused before it runs',
    run(db) {
      const sqlite = db.sqlite;
      const destructive: Migration = {
        version: 1,
        sql: '-- requires_confirmation: true\nDROP TABLE songs;',
      };
      const err = throws(
        () => applyForwardMigrations(sqlite, 0, 1, [destructive]),
        'a destructive migration',
      );
      equal(errorName(err), 'DestructiveForwardMigrationError', 'the error class');
      equal(sqlite.pragma('user_version', { simple: true }), 0, 'nothing was applied');

      // And the predicate itself, without the runner around it.
      throws(() => assertNotDestructive(destructive), 'the marker alone');
      assertNotDestructive({ version: 1, sql: 'CREATE TABLE t (id TEXT);' });
    },
  },
  {
    group: GROUP,
    name: 'the chain leaves the audio migration flag pending, and clearing it works',
    run(db) {
      // 0003 marks every library reaching v3 as owing the mp3 -> m4a
      // conversion, because it cannot know what is in `songs/`. A fresh mobile
      // library inherits that '1' and MUST clear it at bootstrap — through this
      // very function, not a hand-written UPDATE (decision j).
      const sqlite = migrate(db.sqlite);
      equal(
        scalar(
          sqlite,
          'SELECT value FROM local_metadata WHERE key = ?',
          AUDIO_MIGRATION_PENDING_KEY,
        ),
        '1',
        'the chain sets it',
      );
      check(isAudioMigrationPending(sqlite), 'isAudioMigrationPending agrees');

      clearAudioMigrationPending(sqlite);
      check(!isAudioMigrationPending(sqlite), 'cleared');
      equal(
        scalar(
          sqlite,
          'SELECT value FROM local_metadata WHERE key = ?',
          AUDIO_MIGRATION_PENDING_KEY,
        ),
        '0',
        "the row is kept at '0' rather than deleted",
      );
    },
  },
  {
    group: GROUP,
    name: 'the migrated schema survives a reopen',
    run(db) {
      const sqlite = migrate(db.sqlite);
      assertCurrentSchema(sqlite, DB_PATH);
      const reopened = db.reopen();
      equal(
        reopened.pragma('user_version', { simple: true }),
        LATEST_KNOWN_VERSION,
        'version persisted',
      );
      assertCurrentSchema(reopened, DB_PATH);
    },
  },
];
