import type { UpdateSongRequest } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { fakeContext, song } from '../testing/fake-backend.js';
import { runUrlGet, runUrlRecognize, runUrlSet } from './url.js';

const SONG_ID = '11111111-2222-4333-8444-555555555555';

const RECOGNISED = {
  source_url: 'https://www.bilibili.com/video/BV1xx411c7mD',
  source_provider: 'bilibili',
  source_key: 'BV1xx411c7mD:123',
  video_title: '周杰伦 - 晴天',
};

describe('songs url get', () => {
  it('prints the triple', async () => {
    const ctx = fakeContext({
      songs: [
        song({
          id: SONG_ID,
          name: '晴天',
          source_url: 'https://www.bilibili.com/video/BV1',
          source_provider: 'bilibili',
          source_key: 'BV1:2',
        }),
      ],
    });
    await runUrlGet(ctx, '晴天');

    expect(ctx.streams.stdout.join('\n')).toContain('BV1:2');
  });

  it('says （无） rather than printing nothing for a song with no source', async () => {
    const ctx = fakeContext({ songs: [song({ id: SONG_ID, name: '晴天' })] });
    await runUrlGet(ctx, SONG_ID);
    expect(ctx.streams.stdout.join('\n')).toContain('（无）');
  });

  it('--json prints the song envelope verbatim', async () => {
    const ctx = fakeContext({ songs: [song({ id: SONG_ID })] }, { json: true });
    await runUrlGet(ctx, SONG_ID);
    expect(ctx.streams.stdout).toHaveLength(1);
    expect(JSON.parse(ctx.streams.stdout[0] as string).data.id).toBe(SONG_ID);
  });
});

describe('songs url set', () => {
  it('sends the url ALONE, so the daemon re-derives provider and key', async () => {
    const ctx = fakeContext({ songs: [song({ id: SONG_ID })] });
    await runUrlSet(ctx, SONG_ID, 'https://b23.tv/abc');

    expect(ctx.backend.argsOf('updateSong')).toEqual([
      SONG_ID,
      { source_url: 'https://b23.tv/abc' },
    ]);
  });

  it('an empty string clears the link', async () => {
    const ctx = fakeContext({ songs: [song({ id: SONG_ID })] });
    await runUrlSet(ctx, SONG_ID, '');

    const patch = ctx.backend.argsOf('updateSong')?.[1] as UpdateSongRequest;
    expect(patch.source_url).toBeNull();
    expect(ctx.streams.stdout[0]).toContain('已清除');
  });
});

describe('songs url recognize', () => {
  it('is a preview: it writes nothing and says so', async () => {
    const ctx = fakeContext({ songs: [song({ id: SONG_ID })], recognize: RECOGNISED });
    await runUrlRecognize(ctx, SONG_ID, 'https://b23.tv/abc', {});

    expect(ctx.backend.names()).toEqual(['recognizeUrl']);
    expect(ctx.backend.argsOf('recognizeUrl')).toEqual([SONG_ID, 'https://b23.tv/abc']);
    expect(ctx.streams.stdout.join('\n')).toContain('--save');
  });

  it('omits the url entirely when none was given', async () => {
    // "Re-check the link already on the song" is a bodyless request, not
    // `{url: undefined}`.
    const ctx = fakeContext({ songs: [song({ id: SONG_ID })], recognize: RECOGNISED });
    await runUrlRecognize(ctx, SONG_ID, undefined, {});
    expect(ctx.backend.argsOf('recognizeUrl')).toEqual([SONG_ID, undefined]);
  });

  it('--save stores the triple that was just shown, explicitly', async () => {
    const ctx = fakeContext({ songs: [song({ id: SONG_ID })], recognize: RECOGNISED });
    await runUrlRecognize(ctx, SONG_ID, undefined, { save: true });

    expect(ctx.backend.argsOf('updateSong')).toEqual([
      SONG_ID,
      {
        source_url: RECOGNISED.source_url,
        source_provider: RECOGNISED.source_provider,
        source_key: RECOGNISED.source_key,
      },
    ]);
  });

  it('--json in preview mode prints the recognition envelope', async () => {
    const ctx = fakeContext(
      { songs: [song({ id: SONG_ID })], recognize: RECOGNISED },
      { json: true },
    );
    await runUrlRecognize(ctx, SONG_ID, undefined, {});

    expect(ctx.streams.stdout).toHaveLength(1);
    expect(JSON.parse(ctx.streams.stdout[0] as string).data).toEqual(RECOGNISED);
  });
});
