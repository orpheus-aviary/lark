// `migration-backup/`: what it is holding, and what clearing it does
// (0.3.0 T3b; 判据 51, 61).
//
// The interesting assertions are the two refusals. A `backup_path` that points
// out of the directory is not followed — not to size it, not to delete it —
// because those rows are written by this code and one that escapes means the
// database was edited. And the ledger is updated BEFORE the files go, so no row
// ever says "your original is safe in the backup" about a file that is gone.

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/index.js';
import { larkDir, migrationBackupDir } from '../paths.js';
import { clearMigrationBackups, resolveBackupPath, summarizeMigrationBackups } from './backup.js';
import { BACKUP_CLEARED_MARK, type MigrationStatus, getLedgerRow } from './ledger.js';

let nest: string;
let sqlite: BetterSqlite3.Database;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-backup-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

/** A ledger row pointing at a backup file, with that file written. */
function seed(
  objectKey: string,
  status: MigrationStatus,
  options: { bytes?: number; backupPath?: string; write?: boolean } = {},
): void {
  const relative = options.backupPath ?? join('migration-backup', `${objectKey}.mp3`);
  sqlite
    .prepare(
      `INSERT INTO audio_migration
         (object_key, song_id, class, source_key_present, status, backup_path, at)
       VALUES (?, ?, 'A', 0, ?, ?, 0)`,
    )
    .run(objectKey, objectKey, status, relative);
  if (options.write === false) return;
  const absolute = join(larkDir(), relative);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, Buffer.alloc(options.bytes ?? 100, 1));
}

describe('resolveBackupPath', () => {
  it('accepts what the ledger actually writes', () => {
    expect(resolveBackupPath('migration-backup/abc.mp3')).toBe(
      join(migrationBackupDir(), 'abc.mp3'),
    );
    expect(resolveBackupPath('migration-backup/orphans/abc.mp3')).toBe(
      join(migrationBackupDir(), 'orphans', 'abc.mp3'),
    );
  });

  it('refuses anything that leaves the directory', () => {
    expect(resolveBackupPath('../songs/x/song.mp3')).toBeNull();
    expect(resolveBackupPath('migration-backup/../../etc/passwd')).toBeNull();
    expect(resolveBackupPath('/etc/passwd')).toBeNull();
    expect(resolveBackupPath('')).toBeNull();
    // The directory itself is not a file in it.
    expect(resolveBackupPath('migration-backup')).toBeNull();
  });
});

describe('summarizeMigrationBackups', () => {
  it('is zero before anything is backed up', () => {
    expect(summarizeMigrationBackups(sqlite)).toEqual({
      file_count: 0,
      bytes: 0,
      asset_count: 0,
      asset_bytes: 0,
    });
  });

  it('separates the irreplaceable originals from the rest', () => {
    seed('kept-one', 'kept_unconverted', { bytes: 500 });
    seed('converted', 'done', { bytes: 300 });
    seed('orphan-one', 'kept_unconverted', {
      bytes: 200,
      backupPath: join('migration-backup', 'orphans', 'orphan-one.mp3'),
    });

    expect(summarizeMigrationBackups(sqlite)).toEqual({
      file_count: 3,
      bytes: 1000,
      // Only the two that could not be converted; the `done` one has an m4a.
      asset_count: 2,
      asset_bytes: 700,
    });
  });

  it('does not follow a row that points outside the backup directory', () => {
    const outside = join(nest, 'lark', 'songs', 'escape.mp3');
    mkdirSync(join(outside, '..'), { recursive: true });
    writeFileSync(outside, Buffer.alloc(999, 1));
    seed('escapee', 'kept_unconverted', {
      backupPath: join('songs', 'escape.mp3'),
      write: false,
    });

    const summary = summarizeMigrationBackups(sqlite);
    expect(summary).toEqual({ file_count: 0, bytes: 0, asset_count: 0, asset_bytes: 0 });
    expect(statSync(outside).size).toBe(999);
  });
});

describe('clearMigrationBackups', () => {
  it('removes the files and says what it freed', () => {
    seed('one', 'kept_unconverted', { bytes: 400 });
    seed('two', 'done', { bytes: 600 });

    expect(clearMigrationBackups(sqlite)).toEqual({ removed_count: 2, freed_bytes: 1000 });
    expect(summarizeMigrationBackups(sqlite)).toEqual({
      file_count: 0,
      bytes: 0,
      asset_count: 0,
      asset_bytes: 0,
    });
  });

  it('stops the ledger claiming a backup that is gone', () => {
    seed('one', 'kept_unconverted');
    clearMigrationBackups(sqlite, 1234);

    const row = getLedgerRow(sqlite, 'one');
    expect(row?.backup_path).toBeNull();
    expect(row?.reconcile_action).toBe(BACKUP_CLEARED_MARK);
    expect(row?.at).toBe(1234);
    // The outcome itself is untouched: the file was deleted on request, which
    // is not the same event as "we could not convert it".
    expect(row?.status).toBe('kept_unconverted');
  });

  it('keeps an earlier reconcile note beside the mark', () => {
    seed('one', 'done');
    sqlite.prepare("UPDATE audio_migration SET reconcile_action = '迁移完成后又出现了 mp3'").run();

    clearMigrationBackups(sqlite);

    expect(getLedgerRow(sqlite, 'one')?.reconcile_action).toBe(
      `迁移完成后又出现了 mp3；${BACKUP_CLEARED_MARK}`,
    );
  });

  it('is safe to run again on a directory that is already gone', () => {
    expect(clearMigrationBackups(sqlite)).toEqual({ removed_count: 0, freed_bytes: 0 });
  });

  it('leaves a file a row points at outside the directory alone', () => {
    const outside = join(nest, 'lark', 'songs', 'escape.mp3');
    mkdirSync(join(outside, '..'), { recursive: true });
    writeFileSync(outside, Buffer.alloc(50, 1));
    seed('escapee', 'kept_unconverted', {
      backupPath: join('songs', 'escape.mp3'),
      write: false,
    });

    expect(clearMigrationBackups(sqlite)).toEqual({ removed_count: 0, freed_bytes: 0 });
    expect(statSync(outside).size).toBe(50);
  });
});
