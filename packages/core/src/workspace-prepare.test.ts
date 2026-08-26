// Criterion 117 (N7e): a claim is a COPY, and the library it came from is
// exactly what it was afterwards — openable, playable, and bound to nothing.
//
// Plus the two properties that make the operation safe to be interrupted: the
// workspace only ever comes into existence complete, and an account that
// already has one keeps it.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from './db/index.js';
import * as paths from './paths.js';
import { computeWorkspaceId } from './portable/index.js';
import { prepareWorkspace } from './workspace-prepare.js';

const ID = computeWorkspaceId('srv', 'usr');
const SONG = '11111111-2222-4333-8444-555555555555';

let nest: string;
let lark: string;
let source: BetterSqlite3.Database;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-prepare-'));
  lark = join(nest, 'lark');
  mkdirSync(lark, { recursive: true });
  vi.stubEnv('LARK_NEST_DIR', nest);
  paths.invalidateActiveWorkspace();

  ({ sqlite: source } = createDatabase({ dbPath: join(lark, 'songs.db') }));
  source
    .prepare(
      `INSERT INTO songs (id, name, artist, file_origin, created_at, updated_at)
       VALUES (?, '第一首', '某人', 'downloaded', 1, 1)`,
    )
    .run(SONG);
  mkdirSync(join(lark, 'songs', SONG), { recursive: true });
  writeFileSync(join(lark, 'songs', SONG, 'song.m4a'), 'audio bytes');
});

afterEach(() => {
  source.close();
  vi.unstubAllEnvs();
  paths.invalidateActiveWorkspace();
  rmSync(nest, { recursive: true, force: true });
});

const claim = () =>
  prepareWorkspace({
    id: ID,
    origin: 'claim',
    source,
    sourceSongs: join(lark, 'songs'),
  });

const names = (db: BetterSqlite3.Database): string[] =>
  (db.prepare('SELECT name FROM songs ORDER BY created_at').all() as { name: string }[]).map(
    (row) => row.name,
  );

/** The source library, through the handle that already has it open. */
const sourceSongs = (): string[] => names(source);

/** A prepared workspace, opened read-only. Nothing else is holding it. */
function preparedSongs(root: string): string[] {
  const db = new BetterSqlite3(join(root, 'songs.db'), { readonly: true });
  try {
    return names(db);
  } finally {
    db.close();
  }
}

describe('claiming the current library', () => {
  it('copies the library and its audio', async () => {
    const result = await claim();
    expect(result).toEqual({ id: ID, created: true, origin: 'claim' });

    const target = paths.workspacePaths(ID);
    expect(preparedSongs(target.root)).toEqual(['第一首']);
    // The user's choice: the audio comes too, so the new workspace plays
    // rather than showing every song as "needs downloading".
    expect(readFileSync(join(target.songs, SONG, 'song.m4a'), 'utf-8')).toBe('audio bytes');
  });

  it('leaves the original complete and bound to nothing (criterion 117)', async () => {
    await claim();
    expect(sourceSongs()).toEqual(['第一首']);
    expect(readFileSync(join(lark, 'songs', SONG, 'song.m4a'), 'utf-8')).toBe('audio bytes');
    // The whole reason a claim is a copy: account sync must never write the
    // library somebody has been using offline.
    expect(source.prepare('SELECT count(*) AS n FROM sync_binding').get()).toEqual({ n: 0 });
  });

  it('is a copy, not a link — writing to one does not reach the other', async () => {
    await claim();
    const target = paths.workspacePaths(ID);
    source
      .prepare(
        `INSERT INTO songs (id, name, artist, file_origin, created_at, updated_at)
         VALUES ('22222222-3333-4444-8555-666666666666', '第二首', '某人', 'downloaded', 2, 2)`,
      )
      .run();
    expect(sourceSongs()).toEqual(['第一首', '第二首']);
    expect(preparedSongs(target.root)).toEqual(['第一首']);
  });
});

describe('a fresh workspace', () => {
  it('is an empty library at the current schema', async () => {
    const result = await prepareWorkspace({ id: ID, origin: 'fresh' });
    expect(result).toEqual({ id: ID, created: true, origin: 'fresh' });
    expect(preparedSongs(paths.workspacePaths(ID).root)).toEqual([]);
  });

  it('does not touch the library it was started from (criterion 116)', async () => {
    const before = source.prepare('SELECT count(*) AS n FROM sync_changes').get();
    await prepareWorkspace({ id: ID, origin: 'fresh' });
    expect(source.prepare('SELECT count(*) AS n FROM sync_changes').get()).toEqual(before);
    expect(sourceSongs()).toEqual(['第一首']);
  });
});

describe('an account that already has a workspace here', () => {
  it('keeps it — this is what makes logging in twice land on one copy', async () => {
    await claim();
    const target = paths.workspacePaths(ID);
    writeFileSync(join(target.root, 'marker'), 'do not touch me');

    const again = await prepareWorkspace({ id: ID, origin: 'fresh' });

    expect(again).toEqual({ id: ID, created: false, origin: 'existing' });
    expect(existsSync(join(target.root, 'marker'))).toBe(true);
    expect(preparedSongs(target.root)).toEqual(['第一首']);
  });
});

describe('when it cannot finish', () => {
  it('leaves no workspace behind, and no staging directory either', async () => {
    await expect(
      prepareWorkspace({ id: ID, origin: 'claim', sourceSongs: join(lark, 'songs') }),
    ).rejects.toThrow(/source library/);

    // `decideActiveWorkspace` gates on `libraries/<id>/songs.db`, so a
    // half-built workspace must never exist under that name.
    expect(existsSync(paths.workspacePaths(ID).root)).toBe(false);
    expect(readdirSync(paths.librariesDir())).toEqual([]);
  });
});

describe('what it refuses', () => {
  it('will not prepare `local`, which is not an account’s', async () => {
    await expect(prepareWorkspace({ id: 'local', origin: 'fresh' })).rejects.toThrow();
  });

  it('will not prepare an id that is not one', async () => {
    for (const bad of ['', '../elsewhere', ID.toUpperCase()]) {
      await expect(prepareWorkspace({ id: bad, origin: 'fresh' })).rejects.toThrow();
    }
  });
});
