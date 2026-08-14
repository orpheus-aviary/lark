// The landing protocol and its recovery routine, laid out state by state.
//
// This is the file that decides whether a crash costs a user their music, so
// every reachable on-disk state gets its own case — including the two that
// look identical from the filesystem and are told apart only by `had_old`.
// The "crash" is simulated by building the state the protocol would have left
// and then running recovery over it, which is exactly what a kill -9 leaves
// behind.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/index.js';
import type { LarkDatabase } from '../db/index.js';
import { local_metadata } from '../db/schema.js';
import { DownloadCommitError } from '../errors.js';
import { createFileBackedSongInTx, getSong, listSongs } from '../library/songs.js';
import { songsDir, trashDir } from '../paths.js';
import { landSongFile, recoverSongsStore, stagePaths } from './resolve.js';

const SONG_ID = '9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001';
const TASK_ID = '11111111-2222-4333-8444-555555555555';

let nest: string;
let db: LarkDatabase;
let sqlite: BetterSqlite3.Database;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-resolve-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  ({ db, sqlite } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

// ─── State builders ────────────────────────────────────

function songDir(id = SONG_ID): string {
  const dir = join(songsDir(), id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const write = (path: string, text: string) => writeFileSync(path, text);
const read = (path: string) => readFileSync(path, 'utf-8');
const listDir = (dir: string) => readdirSync(dir).sort();
const exists = (path: string) => {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
};

function manifest(
  dir: string,
  taskId: string,
  fields: { mode: 'new' | 'replace'; had_old: boolean },
): void {
  write(
    join(dir, `.pending.${taskId}`),
    JSON.stringify({ task_id: taskId, song_id: SONG_ID, ...fields }),
  );
}

function logRow(taskId: string): void {
  db.insert(local_metadata)
    .values({ key: `download.commit.${taskId}`, value: SONG_ID })
    .run();
}

function seedSong(id = SONG_ID, name = 'seeded'): void {
  sqlite
    .transaction(() => {
      createFileBackedSongInTx(db, { id, name, file_origin: 'downloaded' });
    })
    .immediate();
}

const lastAccessed = (id = SONG_ID): number | null =>
  (
    sqlite.prepare('SELECT last_accessed_at AS at FROM songs WHERE id = ?').get(id) as
      | { at: number | null }
      | undefined
  )?.at ?? null;

/**
 * Only the recovery-log rows. `local_metadata` also holds device_uuid, so a
 * bare row count would never be zero and would hide exactly what this counts.
 */
const logRowCount = () =>
  db
    .select()
    .from(local_metadata)
    .all()
    .filter((row) => row.key.startsWith('download.commit.')).length;

// ─── landSongFile ──────────────────────────────────────

describe('landSongFile', () => {
  it('lands a new song: file in place, row committed, no residue', () => {
    const dir = songDir();
    const paths = stagePaths(SONG_ID, TASK_ID);
    write(paths.transcoded, 'AUDIO');

    const result = landSongFile(db, sqlite, {
      taskId: TASK_ID,
      songId: SONG_ID,
      stagedPath: paths.transcoded,
      mode: 'new',
      commit: () => {
        createFileBackedSongInTx(db, { id: SONG_ID, name: '稻香', file_origin: 'downloaded' });
      },
    });

    expect(result.warnings).toEqual([]);
    expect(read(paths.audio)).toBe('AUDIO');
    expect(listDir(dir)).toEqual(['song.m4a']);
    expect(getSong(db, sqlite, SONG_ID).name).toBe('稻香');
    // The recovery log row exists only between the commit and the cleanup.
    expect(logRowCount()).toBe(0);
  });

  // M5-7: a fresh file is a fresh access, or the LRU picks the song that was
  // just downloaded as its first eviction candidate. It has to be part of the
  // commit — after it, the task has irreversibly succeeded.
  it('stamps last_accessed_at inside the commit transaction', () => {
    songDir();
    const paths = stagePaths(SONG_ID, TASK_ID);
    write(paths.transcoded, 'AUDIO');

    landSongFile(db, sqlite, {
      taskId: TASK_ID,
      songId: SONG_ID,
      stagedPath: paths.transcoded,
      mode: 'new',
      commit: () => {
        createFileBackedSongInTx(db, { id: SONG_ID, name: '稻香', file_origin: 'downloaded' });
      },
    });

    expect(lastAccessed()).not.toBeNull();
  });

  it('rolls the stamp back with everything else when the commit throws', () => {
    songDir();
    seedSong();
    const paths = stagePaths(SONG_ID, TASK_ID);
    write(paths.transcoded, 'NEW');

    expect(() =>
      landSongFile(db, sqlite, {
        taskId: TASK_ID,
        songId: SONG_ID,
        stagedPath: paths.transcoded,
        mode: 'replace',
        commit: () => {
          throw new Error('constraint violated');
        },
      }),
    ).toThrow(DownloadCommitError);

    expect(lastAccessed()).toBeNull();
  });

  it('replaces an existing file and removes the backup', () => {
    const dir = songDir();
    const paths = stagePaths(SONG_ID, TASK_ID);
    seedSong();
    write(paths.audio, 'OLD');
    write(paths.transcoded, 'NEW');

    landSongFile(db, sqlite, {
      taskId: TASK_ID,
      songId: SONG_ID,
      stagedPath: paths.transcoded,
      mode: 'replace',
      commit: () => {},
    });

    expect(read(paths.audio)).toBe('NEW');
    expect(listDir(dir)).toEqual(['song.m4a']);
  });

  // The pre-commit compensation: everything the landing touched goes back.
  it('restores the previous file when the transaction throws', () => {
    const dir = songDir();
    const paths = stagePaths(SONG_ID, TASK_ID);
    seedSong();
    write(paths.audio, 'OLD');
    write(paths.transcoded, 'NEW');

    expect(() =>
      landSongFile(db, sqlite, {
        taskId: TASK_ID,
        songId: SONG_ID,
        stagedPath: paths.transcoded,
        mode: 'replace',
        commit: () => {
          throw new Error('constraint violated');
        },
      }),
    ).toThrow(DownloadCommitError);

    expect(read(paths.audio)).toBe('OLD');
    expect(listDir(dir)).toEqual(['song.m4a']);
    expect(logRowCount()).toBe(0);
  });

  it('removes the whole directory when a NEW song fails to commit', () => {
    const dir = songDir();
    const paths = stagePaths(SONG_ID, TASK_ID);
    write(paths.transcoded, 'NEW');

    expect(() =>
      landSongFile(db, sqlite, {
        taskId: TASK_ID,
        songId: SONG_ID,
        stagedPath: paths.transcoded,
        mode: 'new',
        commit: () => {
          throw new Error('nope');
        },
      }),
    ).toThrow(DownloadCommitError);

    expect(exists(join(dir, 'song.m4a'))).toBe(false);
    expect(readdirSync(songsDir())).toEqual([]);
  });

  // Post-commit, nothing may un-succeed the landing (fourth review ④).
  it('reports a failed cleanup step as a warning, keeping the commit', () => {
    const dir = songDir();
    const paths = stagePaths(SONG_ID, TASK_ID);
    seedSong();
    write(paths.audio, 'OLD');
    write(paths.transcoded, 'NEW');

    const result = landSongFile(db, sqlite, {
      taskId: TASK_ID,
      songId: SONG_ID,
      stagedPath: paths.transcoded,
      mode: 'replace',
      commit: () => {
        // Swap the manifest for a directory: `unlink` cannot remove one, so
        // step 6 fails the way an EPERM or a locked file would.
        rmSync(paths.manifest, { force: true });
        mkdirSync(paths.manifest, { recursive: true });
      },
    });

    expect(result.warnings.some((w) => w.includes('manifest'))).toBe(true);
    expect(read(paths.audio)).toBe('NEW'); // committed, and it stays committed
    expect(logRowCount()).toBe(0); // the other cleanup steps still ran

    // …and the residue it left is exactly what recovery is for.
    rmSync(paths.manifest, { recursive: true });
    writeFileSync(paths.manifest, JSON.stringify({ song_id: SONG_ID, had_old: true }));
    recoverSongsStore(db, sqlite);
    expect(read(paths.audio)).toBe('NEW');
    expect(listDir(dir)).toEqual(['song.m4a']);
  });
});

// ─── recoverSongsStore: the seven forms ────────────────

describe('recoverSongsStore', () => {
  it('form 1: deletes every temp prefix', () => {
    const dir = songDir();
    seedSong();
    write(join(dir, 'song.m4a'), 'GOOD');
    for (const name of [
      `.download.${TASK_ID}.tmp`,
      `.song.${TASK_ID}.m4a.tmp`,
      `.import.${SONG_ID}.tmp`,
      `.pending.${TASK_ID}.tmp`,
      `.lyrics.${SONG_ID}.tmp`,
    ]) {
      write(join(dir, name), 'junk');
    }

    const report = recoverSongsStore(db, sqlite);
    expect(report.tempFilesRemoved).toBe(5);
    expect(listDir(dir)).toEqual(['song.m4a']);
    expect(read(join(dir, 'song.m4a'))).toBe('GOOD');
  });

  it('form 2a: manifest + log row + backup → keeps the new file, sweeps the rest', () => {
    const dir = songDir();
    seedSong();
    write(join(dir, 'song.m4a'), 'NEW');
    write(join(dir, `.replace.${TASK_ID}.bak`), 'OLD');
    manifest(dir, TASK_ID, { mode: 'replace', had_old: true });
    logRow(TASK_ID);

    const report = recoverSongsStore(db, sqlite);
    expect(report.committedSwept).toBe(1);
    expect(read(join(dir, 'song.m4a'))).toBe('NEW');
    expect(listDir(dir)).toEqual(['song.m4a']);
    expect(logRowCount()).toBe(0);
  });

  it('form 2b: manifest + log row, no backup → still keeps the new file', () => {
    const dir = songDir();
    seedSong();
    write(join(dir, 'song.m4a'), 'NEW');
    manifest(dir, TASK_ID, { mode: 'new', had_old: false });
    logRow(TASK_ID);

    recoverSongsStore(db, sqlite);
    expect(read(join(dir, 'song.m4a'))).toBe('NEW');
    expect(listDir(dir)).toEqual(['song.m4a']);
  });

  it('form 3: manifest, no log row, backup present → rolls back to the old file', () => {
    const dir = songDir();
    seedSong();
    write(join(dir, 'song.m4a'), 'HALF-WRITTEN NEW');
    write(join(dir, `.replace.${TASK_ID}.bak`), 'OLD');
    manifest(dir, TASK_ID, { mode: 'replace', had_old: true });

    const report = recoverSongsStore(db, sqlite);
    expect(report.rolledBack).toBe(1);
    expect(read(join(dir, 'song.m4a'))).toBe('OLD');
    expect(listDir(dir)).toEqual(['song.m4a']);
  });

  // The P0 case (fourth review ①). Without `had_old` this state is
  // indistinguishable from form 5, and the old file gets deleted.
  it('form 4: manifest, no log row, no backup, had_old → KEEPS the intact old file', () => {
    const dir = songDir();
    seedSong();
    write(join(dir, 'song.m4a'), 'OLD AND FINE');
    manifest(dir, TASK_ID, { mode: 'replace', had_old: true });

    const report = recoverSongsStore(db, sqlite);
    expect(report.oldFileKept).toBe(1);
    expect(report.rolledBack).toBe(0);
    expect(read(join(dir, 'song.m4a'))).toBe('OLD AND FINE');
    expect(listDir(dir)).toEqual(['song.m4a']);
  });

  it('form 5: manifest, no log row, no backup, !had_old → deletes the uncommitted file', () => {
    const dir = songDir();
    write(join(dir, 'song.m4a'), 'UNCOMMITTED NEW');
    manifest(dir, TASK_ID, { mode: 'new', had_old: false });

    const report = recoverSongsStore(db, sqlite);
    expect(report.rolledBack).toBe(1);
    expect(exists(join(dir, 'song.m4a'))).toBe(false);
    expect(listDir(dir)).toEqual([]);
  });

  it('form 6: audio with no row and no manifest → quarantined, never deleted', () => {
    const dir = songDir();
    write(join(dir, 'song.m4a'), 'ORPHAN');

    const report = recoverSongsStore(db, sqlite);
    expect(report.orphansQuarantined).toBe(1);
    expect(exists(join(dir, 'song.m4a'))).toBe(false);

    const [bucket] = readdirSync(trashDir());
    expect(bucket).toMatch(/^recovery-/);
    expect(read(join(trashDir(), bucket as string, SONG_ID, 'song.m4a'))).toBe('ORPHAN');
  });

  it('form 7: log row with no manifest → dropped', () => {
    seedSong();
    logRow(TASK_ID);

    const report = recoverSongsStore(db, sqlite);
    expect(report.danglingLogRowsRemoved).toBe(1);
    expect(logRowCount()).toBe(0);
  });

  it('treats an unreadable manifest as uncommitted rather than guessing', () => {
    const dir = songDir();
    write(join(dir, 'song.m4a'), 'NEW');
    write(join(dir, `.pending.${TASK_ID}`), '{ this is not json');

    const report = recoverSongsStore(db, sqlite);
    expect(report.rolledBack).toBe(1);
    expect(exists(join(dir, 'song.m4a'))).toBe(false);
  });

  it('leaves a healthy library completely alone', () => {
    const dir = songDir();
    seedSong();
    write(join(dir, 'song.m4a'), 'GOOD');
    write(join(dir, 'lyrics.lrc'), '[00:01.00]x');

    const report = recoverSongsStore(db, sqlite);
    expect(report).toMatchObject({
      tempFilesRemoved: 0,
      committedSwept: 0,
      rolledBack: 0,
      oldFileKept: 0,
      orphansQuarantined: 0,
      danglingLogRowsRemoved: 0,
    });
    expect(listDir(dir)).toEqual(['lyrics.lrc', 'song.m4a']);
    expect(listSongs(db, sqlite).total).toBe(1);
  });

  it('ignores directories that are not song ids', () => {
    mkdirSync(join(songsDir(), 'not-a-uuid'), { recursive: true });
    write(join(songsDir(), 'not-a-uuid', 'song.m4a'), 'x');

    const report = recoverSongsStore(db, sqlite);
    expect(report.orphansQuarantined).toBe(0);
    expect(exists(join(songsDir(), 'not-a-uuid', 'song.m4a'))).toBe(true);
  });

  it('is a no-op when the songs directory does not exist yet', () => {
    expect(() => recoverSongsStore(db, sqlite)).not.toThrow();
  });

  // A landing interrupted at each step, then recovered: the end state must be
  // the same one the protocol promises.
  it('converges a real interrupted landing back to the old file', () => {
    const dir = songDir();
    const paths = stagePaths(SONG_ID, TASK_ID);
    seedSong();
    write(paths.audio, 'OLD');
    write(paths.transcoded, 'NEW');

    // Reproduce steps 2–4 and stop before the transaction.
    manifest(dir, TASK_ID, { mode: 'replace', had_old: true });
    const fs = readFileSync(paths.audio);
    writeFileSync(paths.backup, fs);
    writeFileSync(paths.audio, readFileSync(paths.transcoded));
    rmSync(paths.transcoded);

    recoverSongsStore(db, sqlite);
    expect(read(paths.audio)).toBe('OLD');
    expect(listDir(dir)).toEqual(['song.m4a']);
  });
});
