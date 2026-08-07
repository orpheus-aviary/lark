import { describe, expect, it } from 'vitest';
import type { CliError } from '../lib/errors.js';
import { fakeContext, playlist, song } from '../testing/fake-backend.js';
import {
  runPlaylistAdd,
  runPlaylistCreate,
  runPlaylistDelete,
  runPlaylistList,
  runPlaylistRemove,
  runPlaylistRename,
  runPlaylistReorder,
  runPlaylistSongs,
} from './playlist.js';

const PL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SONG_A = '11111111-2222-4333-8444-555555555555';
const SONG_B = '22222222-3333-4444-8555-666666666666';

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as CliError).code;
  }
}

describe('playlist list / songs', () => {
  it('lists playlists', async () => {
    const ctx = fakeContext({ playlists: [playlist({ name: '收藏', song_count: 3 })] });
    await runPlaylistList(ctx);
    expect(ctx.streams.stdout[0]).toContain('收藏');
    expect(ctx.streams.stdout[0]).toContain('3');
  });

  it('lists the virtual all playlist', async () => {
    const ctx = fakeContext({ playlistSongs: [song({ name: '晴天' })] });
    await runPlaylistSongs(ctx, 'all');

    expect(ctx.backend.argsOf('listPlaylistSongs')).toEqual(['all']);
    expect(ctx.streams.stdout[0]).toContain('晴天');
  });

  it('says so when a playlist is empty', async () => {
    const ctx = fakeContext({ playlists: [playlist({ id: PL, name: '收藏' })], playlistSongs: [] });
    await runPlaylistSongs(ctx, '收藏');
    expect(ctx.streams.stdout).toEqual(['（这个歌单是空的）']);
  });
});

describe('playlist write commands refuse the virtual playlist', () => {
  it.each([
    ['rename', (ctx: ReturnType<typeof fakeContext>) => runPlaylistRename(ctx, 'all', 'x')],
    ['delete', (ctx: ReturnType<typeof fakeContext>) => runPlaylistDelete(ctx, 'all')],
    ['add', (ctx: ReturnType<typeof fakeContext>) => runPlaylistAdd(ctx, 'all', [SONG_A])],
    ['remove', (ctx: ReturnType<typeof fakeContext>) => runPlaylistRemove(ctx, 'all', SONG_A)],
    [
      'reorder',
      (ctx: ReturnType<typeof fakeContext>) =>
        runPlaylistReorder(ctx, 'all', SONG_A, { before: SONG_B }),
    ],
  ])('%s → VIRTUAL_PLAYLIST', async (_label, call) => {
    // `all` is a view, not a row (R3/R24): read it, export it, never write it.
    const ctx = fakeContext({ playlists: [] });
    expect(await codeOf(() => call(ctx))).toBe('VIRTUAL_PLAYLIST');
  });
});

describe('playlist create / rename / delete', () => {
  it('creates by name', async () => {
    const ctx = fakeContext();
    await runPlaylistCreate(ctx, '新歌单');
    expect(ctx.backend.argsOf('createPlaylist')).toEqual(['新歌单']);
  });

  it('renames a playlist found by name', async () => {
    const ctx = fakeContext({ playlists: [playlist({ id: PL, name: '收藏' })] });
    await runPlaylistRename(ctx, '收藏', '最爱');
    expect(ctx.backend.argsOf('renamePlaylist')).toEqual([PL, '最爱']);
  });

  it('asks before deleting', async () => {
    const ctx = fakeContext({ playlists: [playlist({ id: PL, name: '收藏' })] }, { yes: false });
    expect(await codeOf(() => runPlaylistDelete(ctx, '收藏'))).toBe('USAGE_ERROR');
    expect(ctx.backend.names()).not.toContain('deletePlaylist');
  });

  it('deletes once confirmed', async () => {
    const ctx = fakeContext({ playlists: [playlist({ id: PL, name: '收藏' })] });
    await runPlaylistDelete(ctx, '收藏');
    expect(ctx.backend.argsOf('deletePlaylist')).toEqual([PL]);
  });
});

describe('playlist add / remove', () => {
  it('resolves every song, then adds them in ONE request', async () => {
    const ctx = fakeContext({
      playlists: [playlist({ id: PL, name: '收藏' })],
      songs: [song({ id: SONG_A, name: '晴天' }), song({ id: SONG_B, name: '稻香' })],
    });

    await runPlaylistAdd(ctx, '收藏', ['晴天', '稻香']);

    expect(ctx.backend.argsOf('addPlaylistSongs')).toEqual([PL, [SONG_A, SONG_B]]);
    expect(ctx.backend.names().filter((n) => n === 'addPlaylistSongs')).toHaveLength(1);
  });

  it('removes one membership', async () => {
    const ctx = fakeContext({
      playlists: [playlist({ id: PL, name: '收藏' })],
      songs: [song({ id: SONG_A, name: '晴天' })],
    });
    await runPlaylistRemove(ctx, '收藏', '晴天');
    expect(ctx.backend.argsOf('removePlaylistSong')).toEqual([PL, SONG_A]);
  });
});

describe('playlist reorder', () => {
  const base = () =>
    fakeContext({
      playlists: [playlist({ id: PL, name: '收藏' })],
      songs: [song({ id: SONG_A, name: '晴天' }), song({ id: SONG_B, name: '稻香' })],
    });

  it('sends neighbour ids, never an index', async () => {
    const ctx = base();
    await runPlaylistReorder(ctx, '收藏', '晴天', { before: '稻香' });
    expect(ctx.backend.argsOf('reorderPlaylist')).toEqual([
      PL,
      { song_id: SONG_A, before_song_id: SONG_B },
    ]);
  });

  it.each([
    ['neither', {}],
    ['both', { before: '稻香', after: '稻香' }],
  ])('rejects %s anchor', async (_label, opts) => {
    expect(await codeOf(() => runPlaylistReorder(base(), '收藏', '晴天', opts))).toBe(
      'USAGE_ERROR',
    );
  });
});
