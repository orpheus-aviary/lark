// What the scan finds, and what it refuses to touch.
//
// The class it writes decides whether a song's mp3 may ever be deleted, so
// each way of reaching R, A and orphan has its own case — including the ones
// that look like R and are not: an imported file, a source key for a provider
// this build cannot fetch from, a key that is there but empty.

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/index.js';
import { createFileBackedSongInTx } from '../library/songs.js';
import { songsDir } from '../paths.js';
import type { PortableDb } from '../portable/db.js';
import { enqueueLocalDelete } from '../sync/file-ops.js';
import { type MigrationStatus, getLedgerRow, listLedger, updateLedgerRow } from './ledger.js';
import { scanAudioMigration } from './scanner.js';

let nest: string;
let store: PortableDb;
let sqlite: BetterSqlite3.Database;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-scanner-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  ({ sqlite, portable: store } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

/** A directory under songs/, with whatever files were asked for. */
function makeDir(
  name: string,
  files: Record<string, string> = { 'song.mp3': 'mp3 bytes' },
): string {
  const dir = join(songsDir(), name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

interface SongOptions {
  origin?: 'downloaded' | 'imported';
  provider?: string | null;
  key?: string | null;
}

/** A library row plus its directory holding an mp3. */
function seedSong(options: SongOptions = {}): string {
  const id = randomUUID();
  sqlite
    .transaction(() => {
      createFileBackedSongInTx(store, {
        id,
        name: '歌',
        file_origin: options.origin ?? 'downloaded',
        source_provider: options.provider === undefined ? 'bilibili' : options.provider,
        source_key: options.key === undefined ? `BV1x${id.slice(0, 4)}:9` : options.key,
      });
    })
    .immediate();
  makeDir(id);
  return id;
}

describe('classification', () => {
  it('calls a downloaded bilibili song with a key rebuildable', () => {
    const id = seedSong();
    expect(scanAudioMigration(sqlite)).toMatchObject({ inserted: 1, total: 1 });

    expect(getLedgerRow(sqlite, id)).toMatchObject({
      song_id: id,
      class: 'R',
      file_origin: 'downloaded',
      source_key_present: 1,
      status: 'pending',
    });
  });

  // Each of these looks like a download and is not a way back to the file.
  // Getting any of them wrong deletes a user's only copy.
  it.each<[string, SongOptions]>([
    ['an import', { origin: 'imported' }],
    ['no source at all', { provider: null, key: null }],
  ])('calls %s an asset', (_label, options) => {
    const id = seedSong(options);
    scanAudioMigration(sqlite);
    expect(getLedgerRow(sqlite, id)).toMatchObject({ class: 'A', source_key_present: 0 });
  });

  // No write path can produce this today — `normalizeSource` refuses an
  // unknown provider. The scan checks anyway: the day a second provider is
  // added, a library written by that build can be opened by this one, and the
  // question "can I fetch this again" would answer yes for a provider this
  // build has never heard of.
  it('calls a provider this build cannot fetch from an asset', () => {
    const id = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO songs (id, name, artist, source_provider, source_key, file_origin,
           created_at, updated_at)
         VALUES (?, '歌', '', 'soundcloud', 'track-1', 'downloaded', 1, 1)`,
      )
      .run(id);
    makeDir(id);

    scanAudioMigration(sqlite);
    expect(getLedgerRow(sqlite, id)).toMatchObject({ class: 'A', source_key_present: 0 });
  });

  it('calls a directory with no library row an orphan', () => {
    makeDir(randomUUID());
    scanAudioMigration(sqlite);
    expect(listLedger(sqlite)[0]).toMatchObject({ class: 'orphan', song_id: null });
  });

  // The whole reason the scan walks the tree: a crash can leave a directory
  // that was never a song, and it still holds an mp3.
  it('records an object whose name is not a song id', () => {
    makeDir('leftover-from-something');
    scanAudioMigration(sqlite);
    expect(listLedger(sqlite)[0]).toMatchObject({
      object_key: 'leftover-from-something',
      class: 'orphan',
    });
  });
});

describe('what gets a row at all', () => {
  it('ignores a song that already has only an m4a', () => {
    seedSong();
    makeDir(randomUUID(), { 'song.m4a': 'already converted' });
    expect(scanAudioMigration(sqlite)).toMatchObject({ total: 1 });
  });

  it('records a directory holding both, because the mp3 is still there', () => {
    const id = randomUUID();
    makeDir(id, { 'song.mp3': 'old', 'song.m4a': 'new' });
    expect(scanAudioMigration(sqlite)).toMatchObject({ total: 1 });
  });

  it('is a no-op on a library with no songs directory', () => {
    expect(scanAudioMigration(sqlite)).toEqual({
      total: 0,
      inserted: 0,
      unblocked: 0,
      vanished: 0,
    });
  });

  it('ignores files directly under songs/', () => {
    mkdirSync(songsDir(), { recursive: true });
    writeFileSync(join(songsDir(), 'stray.mp3'), 'not in a directory');
    expect(scanAudioMigration(sqlite)).toMatchObject({ total: 0 });
  });
});

describe('rescanning', () => {
  it('adds nothing the second time', () => {
    seedSong();
    scanAudioMigration(sqlite);
    expect(scanAudioMigration(sqlite)).toMatchObject({ inserted: 0, total: 1 });
  });

  it('leaves a terminal row exactly as it was', () => {
    const id = seedSong();
    scanAudioMigration(sqlite);
    updateLedgerRow(sqlite, id, { status: 'lost', last_error: '坏了' }, 5);

    scanAudioMigration(sqlite);
    expect(getLedgerRow(sqlite, id)).toMatchObject({ status: 'lost', last_error: '坏了', at: 5 });
  });

  // The reconciliation table owns these: it can see the m4a and the backup as
  // well as the mp3, and it resumes from `resume_state`. A rescan that reset
  // them to pending would restart a conversion that is half committed.
  it.each<MigrationStatus>(['converting', 'discarding', 'backing_up', 'blocked'])(
    'leaves a %s row alone',
    (status) => {
      const id = seedSong();
      scanAudioMigration(sqlite);
      updateLedgerRow(sqlite, id, { status, resume_state: 'done' }, 7);

      scanAudioMigration(sqlite);
      expect(getLedgerRow(sqlite, id)).toMatchObject({ status, resume_state: 'done', at: 7 });
    },
  );

  it('re-decides a pending row, so a source fixed between boots counts', () => {
    const id = seedSong({ provider: null, key: null });
    scanAudioMigration(sqlite);
    expect(getLedgerRow(sqlite, id)?.class).toBe('A');

    sqlite
      .prepare("UPDATE songs SET source_provider='bilibili', source_key='BV1x:9' WHERE id=?")
      .run(id);
    scanAudioMigration(sqlite);
    expect(getLedgerRow(sqlite, id)?.class).toBe('R');
  });
});

describe('objects a sync file op still owns', () => {
  it('marks them blocked instead of converting them', () => {
    const id = seedSong();
    enqueueLocalDelete(sqlite, id);

    scanAudioMigration(sqlite);
    expect(getLedgerRow(sqlite, id)?.status).toBe('blocked_file_op');
  });

  it('puts them back in the queue once the op is gone', () => {
    const id = seedSong();
    enqueueLocalDelete(sqlite, id);
    scanAudioMigration(sqlite);

    sqlite.prepare('DELETE FROM sync_file_ops').run();
    expect(scanAudioMigration(sqlite)).toMatchObject({ unblocked: 1 });
    expect(getLedgerRow(sqlite, id)?.status).toBe('pending');
  });

  // The op ran and took the song with it. Reporting that as a migration
  // problem would put a warning in the report about a delete the user asked
  // for, and leave a row that can never settle.
  it('forgets them when the resolved op took the object away', () => {
    const id = seedSong();
    enqueueLocalDelete(sqlite, id);
    scanAudioMigration(sqlite);

    sqlite.prepare('DELETE FROM sync_file_ops').run();
    rmSync(join(songsDir(), id), { recursive: true, force: true });

    expect(scanAudioMigration(sqlite)).toMatchObject({ vanished: 1, total: 0 });
    expect(getLedgerRow(sqlite, id)).toBeUndefined();
  });
});
