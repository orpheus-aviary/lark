// Import is the one library write that creates many rows from a file the user
// did not type, so the tests are written around the three ways it could get
// identity wrong — merging songs that only look alike, splitting songs that
// share a key, and letting a stale `reuse` instruction through — plus the
// all-or-nothing guarantee that makes a half-import impossible (R12/R27).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlaylistExportData } from '@lark/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DatabaseHandles, createDatabase } from '../db/index.js';
import {
  InvalidImportFileError,
  InvalidReuseError,
  NotFoundError,
  UnsupportedFormatVersionError,
} from '../errors.js';
import { installNodeRuntime } from '../node-runtime.js';
import { songs } from '../portable/schema.js';
import { songAudioPath, songDirPath } from './lyrics.js';
import { addSongsToPlaylist, createPlaylist, getPlaylistSongs } from './playlists.js';
import { createSong } from './songs.js';
import {
  type ImportEntry,
  buildExport,
  computeMatches,
  importPlaylist,
  parseAndValidate,
  previewImport,
} from './transfer.js';

// `parseAndValidate` hashes whole files through the installed provider, and
// this test imports the module directly rather than through the barrel that
// normally installs it (N1a).
installNodeRuntime();

let nest: string;
let handles: DatabaseHandles;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-transfer-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  handles = createDatabase({ dbPath: ':memory:' });
});

afterEach(() => {
  handles.sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

const db = () => handles.db;
const sq = () => handles.sqlite;

let seq = 0;
const nextKey = (): string => `BV1seed${++seq}:1`;

interface SeedOptions {
  artist?: string;
  key?: string | null;
  file?: boolean;
}

function seed(name: string, options: SeedOptions = {}): string {
  const { artist = '', key = nextKey(), file = false } = options;
  const song = createSong(db(), sq(), {
    name,
    artist,
    ...(key === null ? {} : { source_provider: 'bilibili', source_key: key }),
  });
  if (file) {
    mkdirSync(songDirPath(song.id), { recursive: true });
    writeFileSync(songAudioPath(song.id), Buffer.alloc(8));
  }
  return song.id;
}

/** Rows created in the same millisecond are common; back-date to order them. */
function setCreatedAt(songId: string, at: number): void {
  db().update(songs).set({ created_at: at }).where(eq(songs.id, songId)).run();
}

function entry(name: string, key: string | null, artist = ''): ImportEntry {
  return {
    name,
    artist,
    source_url: key === null ? null : `https://www.bilibili.com/video/${key.split(':')[0]}`,
    source_provider: key === null ? null : 'bilibili',
    source_key: key,
    lyrics_offset: 0,
    duration: 100,
  };
}

function fileOf(entries: readonly ImportEntry[], name = '导出的歌单'): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: 'lark-playlist',
      version: 1,
      exported_at: 1789000000000,
      playlist: { name },
      songs: entries,
    }),
    'utf8',
  );
}

describe('buildExport', () => {
  it('exports a playlist in rank order, with the source pair and no ids', () => {
    const playlist = createPlaylist(db(), sq(), '健身歌单');
    const first = seed('第一首', { key: 'BV1aaa:1', artist: '甲' });
    const second = seed('第二首', { key: 'BV1bbb:2' });
    addSongsToPlaylist(db(), sq(), playlist.id, [second, first]);

    const exported = buildExport(db(), { playlistId: playlist.id });

    expect(exported.format).toBe('lark-playlist');
    expect(exported.version).toBe(1);
    expect(exported.playlist).toEqual({ name: '健身歌单' });
    expect(exported.songs.map((s) => s.name)).toEqual(['第二首', '第一首']);
    expect(exported.songs[1]).toEqual({
      name: '第一首',
      artist: '甲',
      source_url: null,
      source_provider: 'bilibili',
      source_key: 'BV1aaa:1',
      lyrics_offset: 0,
      duration: 0,
    });
    expect(JSON.stringify(exported)).not.toContain(first);
  });

  it('exports the whole library oldest first, under the caller-supplied name', () => {
    const younger = seed('后来的');
    const older = seed('先有的');
    setCreatedAt(older, 1000);
    setCreatedAt(younger, 2000);

    const exported = buildExport(db(), { playlistId: null, name: 'all' });
    expect(exported.playlist.name).toBe('all');
    expect(exported.songs.map((s) => s.name)).toEqual(['先有的', '后来的']);
  });

  it('breaks a created_at tie by id, so a batch-created library has one order', () => {
    const ids = [seed('同毫秒甲'), seed('同毫秒乙'), seed('同毫秒丙')];
    for (const id of ids) setCreatedAt(id, 1000);

    const exported = buildExport(db(), { playlistId: null, name: 'all' });
    const byId = [...ids].sort();
    expect(exported.songs).toHaveLength(3);
    expect(buildExport(db(), { playlistId: null, name: 'all' }).songs).toEqual(exported.songs);
    expect(exported.songs.map((s) => s.name)).toEqual(
      byId.map((id) => (id === ids[0] ? '同毫秒甲' : id === ids[1] ? '同毫秒乙' : '同毫秒丙')),
    );
  });

  it('refuses an unknown playlist', async () => {
    expect(() => buildExport(db(), { playlistId: '00000000-0000-4000-8000-000000000000' })).toThrow(
      NotFoundError,
    );
  });
});

describe('parseAndValidate', async () => {
  it('hashes the exact bytes and normalises the entries', async () => {
    const buffer = fileOf([entry('歌', 'BV1aaa:1', '手')]);
    const parsed = await parseAndValidate(buffer);
    expect(parsed.digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await parseAndValidate(buffer)).digest).toBe(parsed.digest);
    expect(
      (await parseAndValidate(fileOf([entry('歌', 'BV1aaa:1', '手')], '别的名字'))).digest,
    ).not.toBe(parsed.digest);
    expect(parsed.playlist_name).toBe('导出的歌单');
    expect(parsed.entries).toHaveLength(1);
  });

  it('fills in what an entry omits and ignores what it does not know', async () => {
    const buffer = Buffer.from(
      JSON.stringify({
        format: 'lark-playlist',
        version: 1,
        playlist: { name: 'x', colour: 'red' },
        songs: [{ name: '只有名字', mood: 'calm' }],
      }),
    );
    expect((await parseAndValidate(buffer)).entries[0]).toEqual({
      name: '只有名字',
      artist: '',
      source_url: null,
      source_provider: null,
      source_key: null,
      lyrics_offset: 0,
      duration: 0,
    });
  });

  it.each([
    ['not json', Buffer.from('{oops', 'utf8')],
    ['not an object', Buffer.from('[]', 'utf8')],
    [
      'a foreign format',
      Buffer.from(JSON.stringify({ format: 'spotify', version: 1, playlist: {}, songs: [] })),
    ],
    [
      'a nameless playlist',
      Buffer.from(JSON.stringify({ format: 'lark-playlist', version: 1, playlist: {}, songs: [] })),
    ],
    [
      'a nameless song',
      Buffer.from(
        JSON.stringify({
          format: 'lark-playlist',
          version: 1,
          playlist: { name: 'x' },
          songs: [{ artist: '甲' }],
        }),
      ),
    ],
    [
      'a half-set source pair',
      Buffer.from(
        JSON.stringify({
          format: 'lark-playlist',
          version: 1,
          playlist: { name: 'x' },
          songs: [{ name: '歌', source_provider: 'bilibili' }],
        }),
      ),
    ],
  ])('rejects %s', async (_label, buffer) => {
    await expect(parseAndValidate(buffer)).rejects.toThrow(InvalidImportFileError);
  });

  it('names the version rather than complaining about the shape', async () => {
    const buffer = Buffer.from(
      JSON.stringify({ format: 'lark-playlist', version: 2, playlist: { name: 'x' }, songs: 7 }),
    );
    await expect(parseAndValidate(buffer)).rejects.toThrow(UnsupportedFormatVersionError);
  });
});

describe('computeMatches / previewImport', () => {
  it('reuses a library key hit and counts the rest as new', async () => {
    seed('已有的歌', { key: 'BV1aaa:1' });
    const file = await parseAndValidate(
      fileOf([entry('随便叫什么', 'BV1aaa:1'), entry('新歌', 'BV1ccc:3')]),
    );

    const preview = previewImport(db(), file);
    expect(preview.total).toBe(2);
    expect(preview.reuse_count).toBe(1);
    expect(preview.new_count).toBe(1);
    expect(preview.suspects).toEqual([]);
  });

  it('makes the second entry with the same key reuse the first (M5-13)', async () => {
    const file = await parseAndValidate(
      fileOf([entry('同一首', 'BV1aaa:1'), entry('同一首', 'BV1aaa:1')]),
    );
    expect(computeMatches(db(), file.entries)).toEqual([
      { kind: 'new', candidates: [] },
      { kind: 'file', index: 0 },
    ]);
    const preview = previewImport(db(), file);
    expect(preview.reuse_count).toBe(1);
    expect(preview.new_count).toBe(1);
  });

  it('lists every same-name candidate, oldest first, with its file state', async () => {
    const live = seed('晴天', { artist: '周杰伦', key: 'BV1aaa:1', file: true });
    const studio = seed('晴天', { artist: '周杰伦', key: 'BV1bbb:2' });
    seed('晴天', { artist: '别人' });
    setCreatedAt(live, 1000);
    setCreatedAt(studio, 2000);

    const file = await parseAndValidate(fileOf([entry('晴天', 'BV1zzz:9', '周杰伦')]));
    const preview = previewImport(db(), file);

    expect(preview.suspects).toHaveLength(1);
    expect(preview.suspects[0].index).toBe(0);
    expect(preview.suspects[0].candidates.map((c) => c.id)).toEqual([live, studio]);
    expect(preview.suspects[0].candidates.map((c) => c.has_file)).toEqual([true, false]);
    // A suspect is a NEW entry by default — it must not shrink new_count.
    expect(preview.new_count).toBe(1);
    expect(preview.reuse_count).toBe(0);
  });
});

describe('importPlaylist', () => {
  it('round-trips an export with zero new songs', async () => {
    const source = createPlaylist(db(), sq(), '原歌单');
    const a = seed('甲歌', { key: 'BV1aaa:1' });
    const b = seed('乙歌', { key: 'BV1bbb:2' });
    addSongsToPlaylist(db(), sq(), source.id, [a, b]);

    const exported: PlaylistExportData = buildExport(db(), { playlistId: source.id });
    const file = await parseAndValidate(Buffer.from(JSON.stringify(exported)));
    const result = importPlaylist(db(), sq(), {
      entries: file.entries,
      target: { kind: 'new', name: file.playlist_name },
    });

    expect(result).toMatchObject({ total: 2, created: 0, reused: 2, added: 2 });
    expect(db().select().from(songs).all()).toHaveLength(2);
    const members = getPlaylistSongs(db(), sq(), result.playlist_id as string);
    expect(members.map((s) => s.id)).toEqual([a, b]);
  });

  it('creates one song for repeated keys and appends in file order', async () => {
    const target = createPlaylist(db(), sq(), '目标');
    const file = await parseAndValidate(
      fileOf([entry('丙', 'BV1ccc:3'), entry('丁', 'BV1ddd:4'), entry('丙又一次', 'BV1ccc:3')]),
    );

    const result = importPlaylist(db(), sq(), {
      entries: file.entries,
      target: { kind: 'playlist', playlistId: target.id },
    });

    expect(result).toMatchObject({ total: 3, created: 2, reused: 1, added: 2 });
    expect(getPlaylistSongs(db(), sq(), target.id).map((s) => s.name)).toEqual(['丙', '丁']);
  });

  it('imports into the library only when there is no target', async () => {
    const file = await parseAndValidate(fileOf([entry('无歌单', 'BV1eee:5')]));
    const result = importPlaylist(db(), sq(), {
      entries: file.entries,
      target: { kind: 'library' },
    });
    expect(result.playlist_id).toBeNull();
    expect(result.added).toBe(0);
    expect(db().select().from(songs).all()).toHaveLength(1);
  });

  it('skips songs already in the target playlist', async () => {
    const target = createPlaylist(db(), sq(), '目标');
    const existing = seed('已在歌单里', { key: 'BV1fff:6' });
    addSongsToPlaylist(db(), sq(), target.id, [existing]);

    const file = await parseAndValidate(fileOf([entry('已在歌单里', 'BV1fff:6')]));
    const result = importPlaylist(db(), sq(), {
      entries: file.entries,
      target: { kind: 'playlist', playlistId: target.id },
    });

    expect(result).toMatchObject({ created: 0, reused: 1, added: 0 });
    expect(getPlaylistSongs(db(), sq(), target.id)).toHaveLength(1);
  });

  it('rolls the whole import back when any part of it fails (R27)', async () => {
    const file = await parseAndValidate(fileOf([entry('甲', 'BV1aaa:1'), entry('乙', 'BV1bbb:2')]));
    expect(() =>
      importPlaylist(db(), sq(), {
        entries: file.entries,
        target: { kind: 'playlist', playlistId: '00000000-0000-4000-8000-000000000000' },
      }),
    ).toThrow(NotFoundError);
    expect(db().select().from(songs).all()).toEqual([]);
  });

  it('merges an entry the caller chose to reuse', async () => {
    const existing = seed('晴天', { artist: '周杰伦', key: 'BV1aaa:1' });
    const file = await parseAndValidate(fileOf([entry('晴天', 'BV1zzz:9', '周杰伦')]));

    const result = importPlaylist(db(), sq(), {
      entries: file.entries,
      target: { kind: 'library' },
      reuse: [{ index: 0, song_id: existing }],
    });

    expect(result).toMatchObject({ created: 0, reused: 1 });
    expect(db().select().from(songs).all()).toHaveLength(1);
  });

  it('refuses a reuse target that is not a candidate any more', async () => {
    const unrelated = seed('毫不相干', { key: 'BV1aaa:1' });
    const file = await parseAndValidate(fileOf([entry('晴天', 'BV1zzz:9', '周杰伦')]));
    expect(() =>
      importPlaylist(db(), sq(), {
        entries: file.entries,
        target: { kind: 'library' },
        reuse: [{ index: 0, song_id: unrelated }],
      }),
    ).toThrow(InvalidReuseError);
    expect(db().select().from(songs).all()).toHaveLength(1);
  });

  it('refuses to override a key hit, however the caller asks (R12)', async () => {
    seed('库里的', { key: 'BV1aaa:1' });
    const other = seed('另一首', { key: 'BV1bbb:2' });
    const file = await parseAndValidate(fileOf([entry('库里的', 'BV1aaa:1')]));
    expect(() =>
      importPlaylist(db(), sq(), {
        entries: file.entries,
        target: { kind: 'library' },
        reuse: [{ index: 0, song_id: other }],
      }),
    ).toThrow(InvalidReuseError);
  });

  it('refuses a reuse index the file does not have', async () => {
    const existing = seed('存在的', { key: 'BV1aaa:1' });
    const file = await parseAndValidate(fileOf([entry('新的', 'BV1zzz:9')]));
    expect(() =>
      importPlaylist(db(), sq(), {
        entries: file.entries,
        target: { kind: 'library' },
        reuse: [{ index: 7, song_id: existing }],
      }),
    ).toThrow(InvalidReuseError);
  });

  it('leaves imported songs without a file, ready for on-demand download', async () => {
    const file = await parseAndValidate(fileOf([entry('按需下载', 'BV1ggg:7')]));
    importPlaylist(db(), sq(), { entries: file.entries, target: { kind: 'library' } });
    const row = db().select().from(songs).all()[0];
    expect(row.file_origin).toBe('downloaded');
    expect(row.last_accessed_at).toBeNull();
  });
});

describe('import feeds the outbox through the same write paths (v0.2)', () => {
  it('publishes the new playlist, its new songs, and its memberships', async () => {
    const file = await parseAndValidate(fileOf([entry('丙', 'BV1ccc:3'), entry('丁', 'BV1ddd:4')]));
    sq().prepare('DELETE FROM sync_changes').run(); // ignore the fixture's own writes

    importPlaylist(db(), sq(), {
      entries: file.entries,
      target: { kind: 'new', name: '导入的歌单' },
    });

    const ops = (
      sq().prepare('SELECT entity_type, op FROM sync_changes ORDER BY local_seq').all() as {
        entity_type: string;
        op: string;
      }[]
    ).map((c) => `${c.entity_type}.${c.op}`);
    // Import composes the ordinary `…InTx` writers rather than reaching for
    // the tables, so it inherits their emits — including the create/set_rank
    // pair per membership — instead of needing its own.
    expect(ops).toEqual([
      'playlist.create',
      'song.create',
      'song.create',
      'playlist_song.create',
      'playlist_song.set_rank',
      'playlist_song.create',
      'playlist_song.set_rank',
    ]);
  });
});
