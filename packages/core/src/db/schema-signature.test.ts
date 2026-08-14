// The signature's own safety net.
//
// `assertCurrentSchema` used to be called `assertSchemaVN`, so that raising
// LATEST_KNOWN_VERSION broke every call site and forced somebody to look at
// this list. The rename is gone; this file is what replaces it, and it is
// stricter: it asks a freshly migrated database what tables it has and
// insists the signature knows about all of them. A migration that adds a
// table and forgets `REQUIRED_COLUMNS` fails here, not in production on the
// day something drops that table.
//
// (`.exec(...)` below is better-sqlite3's Database#exec — SQL text, not
// child_process.)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SchemaMismatchError } from '../errors.js';
import { createDatabase } from './index.js';
import { REQUIRED_COLUMNS, assertCurrentSchema } from './schema-signature.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-signature-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const dbPath = () => join(dir, 'songs.db');

function userTables(sqlite: BetterSqlite3.Database): string[] {
  return (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe('assertCurrentSchema', () => {
  it('accepts what the migration chain actually builds', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      expect(() => assertCurrentSchema(sqlite, ':memory:')).not.toThrow();
    } finally {
      sqlite.close();
    }
  });

  // The completeness property. Not "the tables I remembered are there" but
  // "the tables that exist are the tables I check".
  it('names every table a fresh migration chain creates', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      expect(userTables(sqlite)).toEqual(Object.keys(REQUIRED_COLUMNS).sort());
    } finally {
      sqlite.close();
    }
  });

  it('reports the first missing table by name', () => {
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    sqlite.close();

    const raw = new BetterSqlite3(dbPath());
    try {
      raw.exec('DROP TABLE sync_dead_letters');
      expect(() => assertCurrentSchema(raw, dbPath())).toThrow(/sync_dead_letters/);
      expect(() => assertCurrentSchema(raw, dbPath())).toThrow(SchemaMismatchError);
    } finally {
      raw.close();
    }
  });

  it('rejects a missing index and a lost CHECK', () => {
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    sqlite.close();

    const raw = new BetterSqlite3(dbPath());
    try {
      raw.exec('DROP INDEX idx_audio_migration_status');
      expect(() => assertCurrentSchema(raw, dbPath())).toThrow(/idx_audio_migration_status/);
      raw.exec('CREATE INDEX idx_audio_migration_status ON audio_migration(status)');

      // A songs table without its file_origin domain would let a bad write
      // land a third origin that nothing downstream handles. Editing
      // sqlite_master needs better-sqlite3's defensive mode off as well as
      // SQLite's own writable_schema — there is no other way to produce a
      // table that has the column but lost the constraint.
      raw.unsafeMode(true);
      raw.pragma('writable_schema = ON');
      raw
        .prepare(
          `UPDATE sqlite_master SET sql = replace(sql, ?, ?)
            WHERE type = 'table' AND name = 'songs'`,
        )
        .run("file_origin IN ('downloaded','imported')", 'file_origin IS NOT NULL');
      raw.pragma('writable_schema = OFF');
    } finally {
      raw.close();
    }

    const reopened = new BetterSqlite3(dbPath());
    try {
      expect(() => assertCurrentSchema(reopened, dbPath())).toThrow(/CHECK/);
    } finally {
      reopened.close();
    }
  });
});
