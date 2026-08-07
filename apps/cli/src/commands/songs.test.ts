import { describe, expect, it } from 'vitest';
import type { CliError } from '../lib/errors.js';
import { fakeContext, song } from '../testing/fake-backend.js';
import { runSongsDelete, runSongsEdit, runSongsGet, runSongsList, runSongsPin } from './songs.js';

const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = '22222222-3333-4444-8555-666666666666';

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as CliError).code;
  }
}

describe('songs list', () => {
  it('prints one line per song', async () => {
    const ctx = fakeContext({
      songs: [song({ name: '晴天' }), song({ id: UUID_B, name: '稻香' })],
    });
    await runSongsList(ctx, {});

    expect(ctx.streams.stdout).toHaveLength(2);
    expect(ctx.streams.stdout[0]).toContain('晴天');
  });

  it('--json prints the envelope verbatim, total included', async () => {
    const ctx = fakeContext({ songs: [song()] }, { json: true });
    await runSongsList(ctx, {});

    expect(ctx.streams.stdout).toHaveLength(1);
    const envelope = JSON.parse(ctx.streams.stdout[0] as string) as { total: number };
    expect(envelope.total).toBe(1);
  });

  it('says so instead of printing nothing', async () => {
    const ctx = fakeContext({ songs: [] });
    await runSongsList(ctx, {});
    expect(ctx.streams.stdout).toEqual(['（没有歌曲）']);
  });

  it.each([
    ['--sort', { sort: 'nonsense' }],
    ['--order', { order: 'sideways' }],
    ['--limit', { limit: '0' }],
    ['--limit', { limit: 'abc' }],
    ['--offset', { offset: '-1' }],
  ])('rejects a bad %s locally, before any request', async (_flag, opts) => {
    // A typo should be a usage error the user can fix, not a daemon 400 —
    // and it must not cost a round-trip.
    const ctx = fakeContext({ songs: [] });
    expect(await codeOf(() => runSongsList(ctx, opts))).toBe('USAGE_ERROR');
    expect(ctx.backend.names()).toEqual([]);
  });

  it('passes a validated query through', async () => {
    const ctx = fakeContext({ songs: [] });
    await runSongsList(ctx, { search: '周', sort: 'name', order: 'desc', limit: '10' });
    expect(ctx.backend.argsOf('listSongs')).toEqual([
      { search: '周', sort: 'name', order: 'desc', limit: 10 },
    ]);
  });
});

describe('songs get', () => {
  it('resolves a name and prints the record', async () => {
    const ctx = fakeContext({ songs: [song({ id: UUID_A, name: '晴天', artist: '周杰伦' })] });
    await runSongsGet(ctx, '晴天');

    expect(ctx.backend.argsOf('getSong')).toEqual([UUID_A]);
    expect(ctx.streams.stdout.join('\n')).toContain('周杰伦');
  });
});

describe('songs edit', () => {
  it('sends only the fields that were given', async () => {
    const ctx = fakeContext({ songs: [song({ id: UUID_A, name: '晴天' })] });
    await runSongsEdit(ctx, UUID_A, { artist: '周杰伦' });
    expect(ctx.backend.argsOf('updateSong')).toEqual([UUID_A, { artist: '周杰伦' }]);
  });

  it('accepts a negative lyrics offset', async () => {
    const ctx = fakeContext({ songs: [song({ id: UUID_A })] });
    await runSongsEdit(ctx, UUID_A, { lyricsOffset: '-2.5' });
    expect(ctx.backend.argsOf('updateSong')).toEqual([UUID_A, { lyrics_offset: -2.5 }]);
  });

  it('refuses an empty patch', async () => {
    const ctx = fakeContext({ songs: [song({ id: UUID_A })] });
    expect(await codeOf(() => runSongsEdit(ctx, UUID_A, {}))).toBe('USAGE_ERROR');
    expect(ctx.backend.names()).toEqual([]);
  });

  it.each([
    ['--duration', { duration: '-1' }],
    ['--duration', { duration: 'soon' }],
    ['--lyrics-offset', { lyricsOffset: 'later' }],
  ])('rejects a bad %s', async (_flag, opts) => {
    const ctx = fakeContext({ songs: [song({ id: UUID_A })] });
    expect(await codeOf(() => runSongsEdit(ctx, UUID_A, opts))).toBe('USAGE_ERROR');
  });
});

describe('songs delete', () => {
  it('resolves EVERY reference before deleting anything', async () => {
    // A run that deletes two songs and then discovers the third name is
    // ambiguous is worse than one that refuses up front.
    const ctx = fakeContext({
      songs: [
        song({ id: UUID_A, name: '晴天' }),
        song({ id: UUID_B, name: '重名' }),
        song({ id: '33333333-4444-4555-8666-777777777777', name: '重名' }),
      ],
    });

    expect(await codeOf(() => runSongsDelete(ctx, ['晴天', '重名']))).toBe('AMBIGUOUS_SONG');
    expect(ctx.backend.names()).not.toContain('deleteSong');
  });

  it('deletes each resolved song and reports the count', async () => {
    const ctx = fakeContext({
      songs: [song({ id: UUID_A, name: '晴天' }), song({ id: UUID_B, name: '稻香' })],
    });

    await runSongsDelete(ctx, ['晴天', '稻香']);

    expect(ctx.backend.names().filter((n) => n === 'deleteSong')).toHaveLength(2);
    expect(ctx.streams.stdout.join('\n')).toContain('2');
  });

  it('asks first: without --yes and without a TTY it refuses', async () => {
    const ctx = fakeContext({ songs: [song({ id: UUID_A, name: '晴天' })] }, { yes: false });
    expect(await codeOf(() => runSongsDelete(ctx, ['晴天']))).toBe('USAGE_ERROR');
    expect(ctx.backend.names()).not.toContain('deleteSong');
  });
});

describe('songs pin', () => {
  it.each([
    [true, '已固定'],
    [false, '已取消固定'],
  ])('pin=%s says %s', async (pinned, expected) => {
    const ctx = fakeContext({ songs: [song({ id: UUID_A })] });
    await runSongsPin(ctx, UUID_A, pinned);

    expect(ctx.backend.argsOf('pinSong')).toEqual([UUID_A, pinned]);
    expect(ctx.streams.stdout.join('\n')).toContain(expected);
  });
});
