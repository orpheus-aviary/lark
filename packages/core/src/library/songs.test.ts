import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DatabaseHandles, createDatabase } from '../db/index.js';
import { songs } from '../db/schema.js';
import {
  InvalidIdError,
  InvalidSourceError,
  NotFoundError,
  SourceKeyConflictError,
} from '../errors.js';
import { setSkybridgeDeviceId } from '../sync/device.js';
import { readTombstone } from '../sync/tombstones.js';
import {
  createSong,
  createSongInTx,
  deleteSong,
  getSong,
  listSongs,
  setFileOrigin,
  setPinned,
  songFileInfo,
  touchLastAccessed,
  updateSong,
} from './songs.js';

let nest: string;
let handles: DatabaseHandles;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-songs-test-'));
  vi.stubEnv('LARK_NEST_DIR', nest); // file paths must NEVER touch the real nest
  handles = createDatabase({ dbPath: ':memory:' });
});

afterEach(() => {
  handles.sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

const db = () => handles.db;
const sq = () => handles.sqlite;

function lwwOf(id: string): { updated_at: number; lww_counter: number } {
  const row = db().select().from(songs).where(eq(songs.id, id)).get();
  if (!row) throw new Error('row gone');
  return { updated_at: row.updated_at, lww_counter: row.lww_counter };
}

function deviceIdOf(id: string): string | null {
  const row = db().select().from(songs).where(eq(songs.id, id)).get();
  if (!row) throw new Error('row gone');
  return row.device_id;
}

describe('createSong / getSong — source quadrants', () => {
  it('creates with all source fields NULL', () => {
    const song = createSong(db(), sq(), { name: '晴天', artist: '周杰伦' });
    const fetched = getSong(db(), sq(), song.id);
    expect(fetched.name).toBe('晴天');
    expect(fetched.artist).toBe('周杰伦');
    expect(fetched.source_url).toBeNull();
    expect(fetched.source_provider).toBeNull();
    expect(fetched.source_key).toBeNull();
    expect(fetched.file_origin).toBe('downloaded');
    expect(fetched.pinned).toBe(false);
  });

  it('url-only is legal (hand-typed non-bilibili link, R8)', () => {
    const song = createSong(db(), sq(), {
      name: 's',
      source_url: 'https://example.com/track/1',
    });
    expect(getSong(db(), sq(), song.id).source_url).toBe('https://example.com/track/1');
  });

  it('key pair without url is legal (identity lives in the key)', () => {
    const song = createSong(db(), sq(), {
      name: 's',
      source_provider: 'bilibili',
      source_key: 'BV1xx411c7mD:123456',
    });
    const fetched = getSong(db(), sq(), song.id);
    expect(fetched.source_provider).toBe('bilibili');
    expect(fetched.source_url).toBeNull();
  });

  it('all three set is legal', () => {
    const song = createSong(db(), sq(), {
      name: 's',
      source_url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      source_provider: 'bilibili',
      source_key: 'BV1xx411c7mD:123456',
    });
    expect(getSong(db(), sq(), song.id).source_key).toBe('BV1xx411c7mD:123456');
  });

  it("normalizes url '' to NULL but rejects '' provider/key", () => {
    const song = createSong(db(), sq(), { name: 's', source_url: '' });
    expect(getSong(db(), sq(), song.id).source_url).toBeNull();
    expect(() =>
      createSong(db(), sq(), { name: 's', source_provider: '', source_key: '' }),
    ).toThrow(InvalidSourceError);
  });

  it('rejects a half-set pair, unknown provider, and bad key syntax', () => {
    expect(() => createSong(db(), sq(), { name: 's', source_provider: 'bilibili' })).toThrow(
      InvalidSourceError,
    );
    expect(() => createSong(db(), sq(), { name: 's', source_key: 'BV1:2' })).toThrow(
      InvalidSourceError,
    );
    expect(() =>
      createSong(db(), sq(), { name: 's', source_provider: 'youtube', source_key: 'abc' }),
    ).toThrow(InvalidSourceError);
    expect(() =>
      createSong(db(), sq(), { name: 's', source_provider: 'bilibili', source_key: 'nonsense' }),
    ).toThrow(InvalidSourceError);
  });

  it('reports the conflicting song id on a key collision', () => {
    const first = createSong(db(), sq(), {
      name: 'a',
      source_provider: 'bilibili',
      source_key: 'BV1xx411c7mD:1',
    });
    try {
      createSong(db(), sq(), {
        name: 'b',
        source_provider: 'bilibili',
        source_key: 'BV1xx411c7mD:1',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SourceKeyConflictError);
      expect((err as SourceKeyConflictError).conflictingSongId).toBe(first.id);
    }
  });
});

describe('updateSong', () => {
  it('bumps the LWW stamp and applies the patch', () => {
    const song = createSong(db(), sq(), { name: 'old', lyrics_offset: -26.5 });
    const before = lwwOf(song.id);
    const updated = updateSong(db(), sq(), song.id, { name: 'new', duration: 187.4 });
    expect(updated.name).toBe('new');
    expect(updated.duration).toBe(187.4);
    expect(updated.lyrics_offset).toBe(-26.5); // untouched fields survive
    const after = lwwOf(song.id);
    const advanced =
      after.updated_at > before.updated_at ||
      (after.updated_at === before.updated_at && after.lww_counter > before.lww_counter);
    expect(advanced).toBe(true);
  });

  it('updating a song to another song’s key conflicts; keeping its own key is fine', () => {
    createSong(db(), sq(), { name: 'a', source_provider: 'bilibili', source_key: 'BVaa:1' });
    const b = createSong(db(), sq(), {
      name: 'b',
      source_provider: 'bilibili',
      source_key: 'BVbb:2',
    });
    expect(() =>
      updateSong(db(), sq(), b.id, { source_provider: 'bilibili', source_key: 'BVaa:1' }),
    ).toThrow(SourceKeyConflictError);
    // no-op key update against itself does not conflict
    const kept = updateSong(db(), sq(), b.id, { name: 'b2' });
    expect(kept.source_key).toBe('BVbb:2');
  });

  it('throws NotFoundError for a missing id', () => {
    expect(() => updateSong(db(), sq(), '9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001', {})).toThrow(
      NotFoundError,
    );
  });
});

describe('local-field paths never touch the LWW triple (R18)', () => {
  it.each([
    ['setPinned', (id: string) => setPinned(db(), sq(), id, true)],
    ['touchLastAccessed', (id: string) => touchLastAccessed(db(), sq(), id, 123456)],
    ['setFileOrigin', (id: string) => setFileOrigin(db(), sq(), id, 'imported')],
  ])('%s', (_name, run) => {
    const song = createSong(db(), sq(), { name: 's' });
    const before = lwwOf(song.id);
    run(song.id);
    expect(lwwOf(song.id)).toEqual(before);
  });

  it('persists the local-field values themselves', () => {
    const song = createSong(db(), sq(), { name: 's' });
    setPinned(db(), sq(), song.id, true);
    touchLastAccessed(db(), sq(), song.id, 42);
    setFileOrigin(db(), sq(), song.id, 'imported');
    const row = db().select().from(songs).where(eq(songs.id, song.id)).get();
    expect(row?.pinned).toBe(true);
    expect(row?.last_accessed_at).toBe(42);
    expect(row?.file_origin).toBe('imported');
  });
});

describe('listSongs — filter → JS sort → id tie-break → slice', () => {
  function seed(names: [string, string][]): string[] {
    return names.map(([name, artist], i) => {
      const song = createSong(db(), sq(), { name, artist });
      // deterministic created_at spacing without sleeping
      db()
        .update(songs)
        .set({ created_at: 1000 + i })
        .where(eq(songs.id, song.id))
        .run();
      return song.id;
    });
  }

  it('sorts by name with zh-CN collation (pinyin order)', () => {
    seed([
      ['播放', 'x'],
      ['安静', 'x'],
      ['晴天', 'x'],
    ]);
    const { songs: rows } = listSongs(db(), sq(), { sort: 'name', order: 'asc' });
    expect(rows.map((s) => s.name)).toEqual(['安静', '播放', '晴天']);
  });

  it('search escapes LIKE wildcards and the escape char itself', () => {
    seed([
      ['100% pure', 'x'],
      ['100 proof', 'x'],
      ['under_score', 'x'],
      ['under-score', 'x'],
      ['back\\slash', 'x'],
    ]);
    expect(listSongs(db(), sq(), { search: '100%' }).songs.map((s) => s.name)).toEqual([
      '100% pure',
    ]);
    expect(listSongs(db(), sq(), { search: 'under_' }).songs.map((s) => s.name)).toEqual([
      'under_score',
    ]);
    expect(listSongs(db(), sq(), { search: '\\' }).songs.map((s) => s.name)).toEqual([
      'back\\slash',
    ]);
  });

  it('search matches artist too', () => {
    seed([
      ['s1', '周杰伦'],
      ['s2', '林俊杰'],
    ]);
    expect(listSongs(db(), sq(), { search: '杰伦' }).songs.map((s) => s.name)).toEqual(['s1']);
  });

  it('paginates across the boundary in one consistent global order', () => {
    seed([
      ['e', 'x'],
      ['d', 'x'],
      ['c', 'x'],
      ['b', 'x'],
      ['a', 'x'],
    ]);
    const full = listSongs(db(), sq(), { sort: 'name', order: 'asc' });
    expect(full.total).toBe(5);
    const page1 = listSongs(db(), sq(), { sort: 'name', order: 'asc', limit: 2, offset: 0 });
    const page2 = listSongs(db(), sq(), { sort: 'name', order: 'asc', limit: 2, offset: 2 });
    const page3 = listSongs(db(), sq(), { sort: 'name', order: 'asc', limit: 2, offset: 4 });
    expect(page1.total).toBe(5);
    expect([...page1.songs, ...page2.songs, ...page3.songs]).toEqual(full.songs);
  });

  it('ties always break by id ASCENDING, even under desc order', () => {
    const ids = seed([
      ['same', 'x'],
      ['same', 'x'],
      ['same', 'x'],
    ]);
    const sortedIds = [...ids].sort();
    const asc = listSongs(db(), sq(), { sort: 'name', order: 'asc' });
    const desc = listSongs(db(), sq(), { sort: 'name', order: 'desc' });
    expect(asc.songs.map((s) => s.id)).toEqual(sortedIds);
    expect(desc.songs.map((s) => s.id)).toEqual(sortedIds);
  });

  it('sorts by created_at desc', () => {
    seed([
      ['first', 'x'],
      ['second', 'x'],
    ]);
    const { songs: rows } = listSongs(db(), sq(), { sort: 'created_at', order: 'desc' });
    expect(rows.map((s) => s.name)).toEqual(['second', 'first']);
  });
});

describe('deleteSong — trash protocol (R22)', () => {
  function makeSongDir(id: string): string {
    const dir = join(nest, 'lark', 'songs', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'song.mp3'), 'mp3bytes');
    return dir;
  }

  it('removes the row and the files, and leaves a tombstone behind', async () => {
    const song = createSong(db(), sq(), { name: 's' });
    const dir = makeSongDir(song.id);

    await deleteSong(db(), sq(), song.id);

    expect(existsSync(dir)).toBe(false);
    expect(() => getSong(db(), sq(), song.id)).toThrow(NotFoundError);
    // Retention will trim the outbox row eventually; after that the tombstone
    // is the only thing that stops a peer's older `create` from resurrecting
    // this song.
    expect(readTombstone(sq(), 'song', song.id)).not.toBeNull();
    expect(
      sq()
        .prepare("SELECT count(*) AS n FROM sync_changes WHERE op='delete' AND entity_id=?")
        .get(song.id),
    ).toEqual({ n: 1 });
    // Drained: nothing owed.
    expect(sq().prepare('SELECT count(*) AS n FROM sync_file_ops').get()).toEqual({ n: 0 });
  });

  it('touches no file when the transaction fails', async () => {
    const song = createSong(db(), sq(), { name: 's' });
    const dir = makeSongDir(song.id);
    sq().pragma('query_only = 1'); // inject a write failure
    try {
      await expect(deleteSong(db(), sq(), song.id)).rejects.toThrow();
    } finally {
      sq().pragma('query_only = 0');
    }
    // v0.1 staged the directory into trash/ FIRST and renamed it back on
    // failure. The journal removes that window entirely: the commit happens
    // before any file is touched, so there is nothing to compensate.
    expect(existsSync(join(dir, 'song.mp3'))).toBe(true);
    expect(getSong(db(), sq(), song.id).id).toBe(song.id); // row survived
    expect(readTombstone(sq(), 'song', song.id)).toBeNull();
  });

  it('works when no directory exists (metadata-only song)', async () => {
    const song = createSong(db(), sq(), { name: 's' });
    await deleteSong(db(), sq(), song.id);
    expect(() => getSong(db(), sq(), song.id)).toThrow(NotFoundError);
  });

  it('rejects non-UUID ids before touching any path (R10)', async () => {
    await expect(deleteSong(db(), sq(), '../etc/passwd')).rejects.toThrow(InvalidIdError);
    await expect(deleteSong(db(), sq(), 'not-a-uuid')).rejects.toThrow(InvalidIdError);
  });
});

describe('the outbox (v0.2)', () => {
  const changes = (id: string) =>
    sq()
      .prepare('SELECT op, payload FROM sync_changes WHERE entity_id = ? ORDER BY local_seq')
      .all(id) as { op: string; payload: string }[];

  it('emits a full create, in the same transaction as the row', () => {
    const song = createSong(db(), sq(), {
      name: '晴天',
      artist: '周杰伦',
      source_provider: 'bilibili',
      source_key: 'BVaa:1',
      duration: 269.5,
    });
    const emitted = changes(song.id);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].op).toBe('create');
    expect(JSON.parse(emitted[0].payload)).toEqual({
      name: '晴天',
      artist: '周杰伦',
      source_url: null,
      source_provider: 'bilibili',
      source_key: 'BVaa:1',
      lyrics_offset: 0,
      duration: 269.5,
      // The row and the payload agree on when the song was born; created_at_ms
      // is immutable across the workspace, so a disagreement would be forever.
      created_at_ms: song.created_at,
      updated_at_ms: song.updated_at,
      lww_counter: lwwOf(song.id).lww_counter,
    });
  });

  it('rolls the change back with the write it describes', () => {
    expect(() =>
      sq()
        .transaction(() => {
          createSongInTx(db(), { name: 'one' });
          throw new Error('boom');
        })
        .immediate(),
    ).toThrow();
    expect(sq().prepare('SELECT count(*) AS n FROM sync_changes').get()).toEqual({ n: 0 });
  });

  it('emits an update, and nothing at all for local fields (R18)', () => {
    const song = createSong(db(), sq(), { name: 'old' });
    updateSong(db(), sq(), song.id, { name: 'new' });
    setPinned(db(), sq(), song.id, true);
    touchLastAccessed(db(), sq(), song.id, 123456);
    setFileOrigin(db(), sq(), song.id, 'imported');

    // Pinning a song on this laptop says nothing to any other device.
    expect(changes(song.id).map((c) => c.op)).toEqual(['create', 'update']);
  });

  it('stamps the registered device id once this library is bound', () => {
    const before = createSong(db(), sq(), { name: 'unbound' });
    expect(deviceIdOf(before.id)).toBeNull();

    setSkybridgeDeviceId(sq(), 'device-7');
    const after = createSong(db(), sq(), { name: 'bound' });
    expect(deviceIdOf(after.id)).toBe('device-7');

    updateSong(db(), sq(), before.id, { name: 'now bound' });
    // The third element of the LWW key is the SERVER's id for this device —
    // the local device_uuid would mean nothing to a peer comparing keys.
    expect(deviceIdOf(before.id)).toBe('device-7');
  });
});

describe('a duplicate source key (D8)', () => {
  /** A duplicate only sync can produce: insert the second row underneath core. */
  function insertDuplicate(key: string): string {
    const id = '9b2abf8a-6b31-40d4-a2f1-8e5c3d21a0ff';
    sq()
      .prepare(
        `INSERT INTO songs (id, name, artist, source_provider, source_key, file_origin,
           created_at, updated_at)
         VALUES (?, 'from a peer', '', 'bilibili', ?, 'downloaded', 1000, 1000)`,
      )
      .run(id, key);
    return id;
  }

  it('does not block editing either song', () => {
    const mine = createSong(db(), sq(), {
      name: 'mine',
      source_provider: 'bilibili',
      source_key: 'BVdup:1',
    });
    insertDuplicate('BVdup:1');

    // The key did not change, so it is not re-checked — otherwise a duplicate
    // the user never created would make its own song unrenameable.
    expect(updateSong(db(), sq(), mine.id, { name: 'renamed' }).name).toBe('renamed');
  });

  it('still refuses to move a key onto a song that already holds one', () => {
    createSong(db(), sq(), { name: 'a', source_provider: 'bilibili', source_key: 'BVaa:1' });
    const b = createSong(db(), sq(), { name: 'b' });
    expect(() =>
      updateSong(db(), sq(), b.id, { source_provider: 'bilibili', source_key: 'BVaa:1' }),
    ).toThrow(SourceKeyConflictError);
  });
});

describe('songFileInfo', () => {
  it('probes disk presence and size', () => {
    const song = createSong(db(), sq(), { name: 's' });
    expect(songFileInfo(song.id)).toEqual({ has_file: false });
    const dir = join(nest, 'lark', 'songs', song.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'song.mp3'), 'abcd');
    expect(songFileInfo(song.id)).toEqual({ has_file: true, file_size: 4 });
  });

  it('rejects non-UUID ids (R10)', () => {
    expect(() => songFileInfo('../x')).toThrow(InvalidIdError);
  });
});

describe('…InTx composition (M5 preview)', () => {
  it('an enclosing transaction rolls back everything as one unit', () => {
    expect(() =>
      sq()
        .transaction(() => {
          createSongInTx(db(), { name: 'one' });
          createSongInTx(db(), { name: 'two' });
          throw new Error('boom — import failed halfway');
        })
        .immediate(),
    ).toThrow(/boom/);
    expect(listSongs(db(), sq()).total).toBe(0);
  });
});
