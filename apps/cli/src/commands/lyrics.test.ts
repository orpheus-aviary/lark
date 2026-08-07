import type { DownloadTasksData } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import type { CliError } from '../lib/errors.js';
import { fakeContext, song, task } from '../testing/fake-backend.js';
import { runLyricsDelete, runLyricsRedownload } from './lyrics.js';

const SONG_ID = '11111111-2222-4333-8444-555555555555';
const NOW = { sleep: () => Promise.resolve(), pollMs: 0 };

const snapshot = (data: Partial<DownloadTasksData>): DownloadTasksData => ({
  tasks: [],
  batches: [],
  ...data,
});

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as CliError).code;
  }
}

describe('lyrics redownload', () => {
  it('resolves the song and follows the task by default', async () => {
    const ctx = fakeContext({
      songs: [song({ id: SONG_ID, name: '晴天' })],
      taskSnapshots: [
        snapshot({ tasks: [task({ kind: 'lyrics', state: 'running', stage: 'lyrics' })] }),
        snapshot({ tasks: [task({ kind: 'lyrics', state: 'succeeded' })] }),
      ],
    });
    await runLyricsRedownload(ctx, '晴天', {}, NOW);

    expect(ctx.backend.argsOf('downloadLyrics')).toEqual([SONG_ID]);
    expect(ctx.streams.stdout).toEqual(['✓ 完成']);
  });

  it('a lyrics task that failed exits through TASK_FAILED', async () => {
    const ctx = fakeContext({
      songs: [song({ id: SONG_ID })],
      taskSnapshots: [
        snapshot({
          tasks: [task({ kind: 'lyrics', state: 'failed', error_message: '三个源都没有找到' })],
        }),
      ],
    });
    expect(await codeOf(() => runLyricsRedownload(ctx, SONG_ID, {}, NOW))).toBe('TASK_FAILED');
  });

  it('--no-wait returns as soon as it is queued', async () => {
    const ctx = fakeContext({ songs: [song({ id: SONG_ID })] });
    await runLyricsRedownload(ctx, SONG_ID, { wait: false }, NOW);
    expect(ctx.backend.names()).toEqual(['downloadLyrics']);
  });
});

describe('lyrics delete', () => {
  it('asks first, then deletes', async () => {
    const ctx = fakeContext({ songs: [song({ id: SONG_ID })] });
    await runLyricsDelete(ctx, SONG_ID);

    expect(ctx.backend.argsOf('deleteLyrics')).toEqual([SONG_ID]);
    expect(ctx.streams.stdout).toEqual(['✓ 已删除歌词']);
  });

  it('refuses without --yes outside a TTY, and deletes nothing', async () => {
    const ctx = fakeContext({ songs: [song({ id: SONG_ID })] }, { yes: false });
    expect(await codeOf(() => runLyricsDelete(ctx, SONG_ID))).toBe('USAGE_ERROR');
    expect(ctx.backend.names()).not.toContain('deleteLyrics');
  });

  it('--json requires --yes rather than prompting', async () => {
    const ctx = fakeContext({ songs: [song({ id: SONG_ID })] }, { yes: false, json: true });
    expect(await codeOf(() => runLyricsDelete(ctx, SONG_ID))).toBe('USAGE_ERROR');
  });
});
