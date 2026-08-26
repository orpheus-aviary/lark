// Criterion 108 (N7c). The only migration in N7, on the only library in this
// project that cannot be re-downloaded, so what is on trial is not that it
// works — it is that being killed at any point costs nothing.
//
// The kill points are a seam in the function itself rather than a
// hand-reconstructed "half moved" tree: reconstructing the state would only
// prove that the reconstruction converges.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWorkspaceIndex } from './config/workspaces.js';
import { createDatabase } from './db/index.js';
import * as paths from './paths.js';
import { WORKSPACE_LOCAL, computeWorkspaceId } from './portable/index.js';
import { readSwitchLock } from './switch-lock.js';
import { type MigrationCrashPoint, migrateBoundNestIntoWorkspace } from './workspace-migrate.js';

const SERVER = 'srv-01H8XGJWBWBAQ4TM4T';
const USER = 'usr-01H8XGJWBWBAQ4TM4T';
const ID = computeWorkspaceId(SERVER, USER);
const SONG = '11111111-2222-4333-8444-555555555555';

let nest: string;
let lark: string;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-nest-migrate-'));
  lark = join(nest, 'lark');
  mkdirSync(lark, { recursive: true });
  vi.stubEnv('LARK_NEST_DIR', nest);
  paths.invalidateActiveWorkspace();
});

afterEach(() => {
  vi.unstubAllEnvs();
  paths.invalidateActiveWorkspace();
  rmSync(nest, { recursive: true, force: true });
});

/** A real library at the nest root, with a song, its file, and credentials. */
function seedLibrary({ bound }: { bound: boolean }): void {
  const { sqlite } = createDatabase({ dbPath: join(lark, 'songs.db') });
  sqlite
    .prepare(
      `INSERT INTO songs (id, name, artist, file_origin, created_at, updated_at)
       VALUES (?, '第一首', '某人', 'downloaded', 1, 1)`,
    )
    .run(SONG);
  if (bound) {
    sqlite
      .prepare(
        `INSERT INTO sync_binding (id, server_id, user_id, workspace_id, schema_version, bound_at)
         VALUES (1, ?, ?, 'ws-1', 3, 1)`,
      )
      .run(SERVER, USER);
  }
  sqlite.close();

  mkdirSync(join(lark, 'songs', SONG), { recursive: true });
  writeFileSync(join(lark, 'songs', SONG, 'song.m4a'), 'audio bytes');
  if (bound) {
    writeFileSync(
      join(lark, 'skybridge.toml'),
      '[server]\nurl = "https://sync.example.test"\n\n[auth]\ntoken = "t"\n',
    );
  }
}

/** Everything that must survive, read from wherever the library now is. */
function libraryContents(root: string): { songs: string[]; audio: string } {
  const sqlite = new BetterSqlite3(join(root, 'songs.db'), { readonly: true });
  try {
    const rows = sqlite.prepare('SELECT name FROM songs').all() as { name: string }[];
    return {
      songs: rows.map((row) => row.name),
      audio: readFileSync(join(root, 'songs', SONG, 'song.m4a'), 'utf-8'),
    };
  } finally {
    sqlite.close();
  }
}

/**
 * The invariant a kill must never break: every piece of the library is at
 * exactly one of the two places.
 *
 * NOT "whole at one place" — mid-move the database can already be at the
 * target while `songs/` is still at the root, and that is the correct,
 * resumable state. What must never happen is a piece being at neither (lost)
 * or at both (about to be merged).
 */
function assertNothingLost(): void {
  const target = paths.workspacePaths(ID).root;
  for (const piece of ['songs.db', join('songs', SONG, 'song.m4a'), 'skybridge.toml']) {
    const atRoot = existsSync(join(lark, piece));
    const atTarget = existsSync(join(target, piece));
    expect({ piece, atRoot, atTarget }).toEqual({ piece, atRoot: !atTarget, atTarget: !atRoot });
  }
  // And wherever the database is, it opens and still has the song in it.
  //
  // 🔴 ON A COPY, and that is the point of the exercise: a read-only
  // connection to a WAL database CREATES `-wal` and `-shm` beside it and does
  // not remove them (M6 measured it in the backup). Opening the real file here
  // would make this assertion the thing that leaves a sidecar at one end —
  // which is exactly the wedge the migration checkpoints its way out of.
  const dbRoot = existsSync(join(lark, 'songs.db')) ? lark : target;
  const peek = join(mkdtempSync(join(tmpdir(), 'lark-peek-')), 'songs.db');
  copyFileSync(join(dbRoot, 'songs.db'), peek);
  const sqlite = new BetterSqlite3(peek, { readonly: true });
  try {
    expect((sqlite.prepare('SELECT name FROM songs').all() as { name: string }[])[0]?.name).toBe(
      '第一首',
    );
  } finally {
    sqlite.close();
    rmSync(dirname(peek), { recursive: true, force: true });
  }
}

describe('a library that is not going anywhere', () => {
  it('leaves an unbound library exactly where it is', () => {
    seedLibrary({ bound: false });
    const result = migrateBoundNestIntoWorkspace();
    expect(result.migrated).toBe(false);
    expect(result.reason).toContain('not bound');
    expect(existsSync(join(lark, 'songs.db'))).toBe(true);
    // And no index is written, so the nest is byte-identical to before.
    expect(existsSync(paths.workspacesPath())).toBe(false);
    expect(paths.resolveActiveWorkspace().id).toBe(WORKSPACE_LOCAL);
  });

  it('does nothing on a nest with no library at all', () => {
    expect(migrateBoundNestIntoWorkspace().reason).toContain('no library');
  });

  it('does nothing once this device has an index', () => {
    seedLibrary({ bound: true });
    expect(migrateBoundNestIntoWorkspace().migrated).toBe(true);
    paths.invalidateActiveWorkspace();
    // The second launch, and every one after it.
    expect(migrateBoundNestIntoWorkspace().reason).toContain('already has an index');
  });

  it('refuses to merge into a workspace that already exists', () => {
    seedLibrary({ bound: true });
    mkdirSync(paths.workspacePaths(ID).root, { recursive: true });
    const result = migrateBoundNestIntoWorkspace();
    expect(result.migrated).toBe(false);
    // Both libraries still there, untouched: nobody can undo a merge.
    expect(existsSync(join(lark, 'songs.db'))).toBe(true);
    expect(libraryContents(lark).songs).toEqual(['第一首']);
  });
});

describe('the move itself', () => {
  beforeEach(() => {
    seedLibrary({ bound: true });
  });

  it('takes the library, its files and its credentials to the workspace', () => {
    const result = migrateBoundNestIntoWorkspace();
    expect(result).toMatchObject({ migrated: true, id: ID, resumed: false });
    expect(result.moved).toEqual(['songs.db', 'songs', 'skybridge.toml']);

    const target = paths.workspacePaths(ID);
    expect(libraryContents(target.root)).toEqual({ songs: ['第一首'], audio: 'audio bytes' });
    expect(existsSync(target.skybridgeConfig)).toBe(true);
    // Nothing of the library is left at the root.
    expect(existsSync(join(lark, 'songs.db'))).toBe(false);
    expect(existsSync(join(lark, 'songs'))).toBe(false);
    expect(existsSync(join(lark, 'skybridge.toml'))).toBe(false);
  });

  it('points the device at it, and names it after the server', () => {
    migrateBoundNestIntoWorkspace();
    const index = readWorkspaceIndex(paths.workspacesPath());
    expect(index.active).toBe(ID);
    expect(index.entries[ID]?.server_url).toBe('https://sync.example.test');
    // And the resolver agrees without needing a restart to notice.
    expect(paths.resolveActiveWorkspace().id).toBe(ID);
    expect(paths.dbPath()).toBe(paths.workspacePaths(ID).db);
  });

  it('leaves the device’s own files at the root', () => {
    writeFileSync(join(lark, 'lark_config.toml'), '[window]\nwidth = 1024\n');
    mkdirSync(join(lark, 'logs'), { recursive: true });
    migrateBoundNestIntoWorkspace();
    expect(existsSync(join(lark, 'lark_config.toml'))).toBe(true);
    expect(existsSync(join(lark, 'logs'))).toBe(true);
  });

  it('holds no lock afterwards — not even when it moved nothing', () => {
    migrateBoundNestIntoWorkspace();
    expect(readSwitchLock()).toBeNull();
  });
});

describe('killed at every point', () => {
  const POINTS: MigrationCrashPoint[] = [
    'after-journal',
    'after-first-move',
    'after-moves',
    'after-index',
  ];

  for (const point of POINTS) {
    it(`resumes to "moved" after a kill ${point}`, () => {
      seedLibrary({ bound: true });

      expect(() =>
        migrateBoundNestIntoWorkspace({
          crashAt: (at) => {
            if (at === point) throw new Error(`killed ${point}`);
          },
        }),
      ).toThrow();
      paths.invalidateActiveWorkspace();

      // ① Never lost: every piece is at exactly one of the two places.
      assertNothingLost();

      // ② The next launch finishes the job.
      const result = migrateBoundNestIntoWorkspace();
      expect(result.migrated).toBe(true);
      expect(result.id).toBe(ID);
      expect(result.resumed).toBe(true);

      const target = paths.workspacePaths(ID);
      expect(libraryContents(target.root)).toEqual({ songs: ['第一首'], audio: 'audio bytes' });
      expect(existsSync(target.skybridgeConfig)).toBe(true);
      expect(existsSync(join(lark, 'songs.db'))).toBe(false);
      expect(readWorkspaceIndex(paths.workspacesPath()).active).toBe(ID);
      expect(paths.resolveActiveWorkspace().id).toBe(ID);

      // ③ And a third launch has nothing left to do.
      paths.invalidateActiveWorkspace();
      expect(migrateBoundNestIntoWorkspace().migrated).toBe(false);
    });
  }

  it('resumes even after somebody READ the half-moved library', () => {
    // 🔴 The wedge this batch found. A read-only connection to a WAL database
    // creates `-wal` and `-shm` and does not remove them, so a crash mid-move
    // plus one curious reader used to leave a sidecar at both ends — and a
    // mover that refuses to overwrite could never converge. The fix is that
    // the sidecars are not moved at all: the database is checkpointed and
    // closed, which leaves nothing to move.
    seedLibrary({ bound: true });
    expect(() =>
      migrateBoundNestIntoWorkspace({
        crashAt: (at) => {
          if (at === 'after-first-move') throw new Error('killed');
        },
      }),
    ).toThrow();

    const target = paths.workspacePaths(ID);
    const reader = new BetterSqlite3(target.db, { readonly: true });
    reader.prepare('SELECT count(*) FROM songs').get();
    reader.close();
    expect(existsSync(`${target.db}-wal`)).toBe(true); // the reader left one

    paths.invalidateActiveWorkspace();
    expect(migrateBoundNestIntoWorkspace().migrated).toBe(true);
    expect(libraryContents(target.root)).toEqual({ songs: ['第一首'], audio: 'audio bytes' });
  });

  it('leaves a crashed run’s lock behind, and the next one takes it anyway', () => {
    // The lock is released in a `finally`, so a THROWN crash gives it back.
    // What a real power cut leaves is a file whose pid is gone — which is the
    // half of `isSwitchLockActive` that exists for exactly this.
    seedLibrary({ bound: true });
    expect(() =>
      migrateBoundNestIntoWorkspace({
        crashAt: (at) => {
          if (at === 'after-journal') throw new Error('killed');
        },
      }),
    ).toThrow();
    expect(readSwitchLock()).toBeNull();
    expect(migrateBoundNestIntoWorkspace().migrated).toBe(true);
  });
});
