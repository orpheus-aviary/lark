import type {
  DownloadBatchGroupInput,
  DownloadSongRequest,
  DownloadTaskData,
  DownloadTasksData,
} from '@lark/shared';
import { describe, expect, it } from 'vitest';
import type { CliError } from '../lib/errors.js';
import { batch, fakeContext, playlist, song, task } from '../testing/fake-backend.js';
import {
  type DownloadDeps,
  assertDownloadShape,
  parsePartSpec,
  runDownload,
  runSongsRedownload,
} from './download.js';

const PLAYLIST_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SONG_ID = '11111111-2222-4333-8444-555555555555';

/** No wall-clock time in the poll loop. */
const NOW: DownloadDeps = { sleep: () => Promise.resolve(), pollMs: 0 };

const snapshot = (data: Partial<DownloadTasksData>): DownloadTasksData => ({
  tasks: [],
  batches: [],
  ...data,
});

/** The usual "queued → succeeded" script. */
const succeeds = (overrides: Partial<DownloadTaskData> = {}): DownloadTasksData[] => [
  snapshot({ tasks: [task({ state: 'queued' })] }),
  snapshot({ tasks: [task({ state: 'succeeded', result: { song_id: 'song-1' }, ...overrides })] }),
];

async function caught(fn: () => Promise<unknown>): Promise<CliError | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as CliError;
  }
}

describe('download — argument shape', () => {
  it('refuses <input> together with --batch', async () => {
    const ctx = fakeContext();
    const err = await caught(() => runDownload(ctx, 'BV1', { batch: 'list.txt' }, NOW));
    expect(err?.code).toBe('USAGE_ERROR');
    expect(ctx.backend.names()).toEqual([]);
  });

  it('refuses neither', async () => {
    const ctx = fakeContext();
    expect((await caught(() => runDownload(ctx, undefined, {}, NOW)))?.code).toBe('USAGE_ERROR');
  });

  it('reads --batch from stdin on `-`', async () => {
    const ctx = fakeContext({ taskSnapshots: [snapshot({ batches: [batch()] })] });
    const stdin = (async function* () {
      yield 'BV1\nBV2\n';
    })();
    await runDownload(ctx, undefined, { batch: '-' }, { ...NOW, stdin });

    const groups = ctx.backend.argsOf('downloadBatch')?.[0] as DownloadBatchGroupInput[];
    expect(groups[0]?.items).toHaveLength(2);
  });
});

// §7 F11 — criterion 44. The flag is about ONE list that came back
// incomplete; on any other shape it used to be accepted and never read.
describe('download — --allow-partial where it cannot apply', () => {
  it('refuses it with --batch, before touching the daemon', async () => {
    const ctx = fakeContext();
    const err = await caught(() =>
      runDownload(ctx, undefined, { batch: 'list.txt', allowPartial: true }, NOW),
    );
    expect(err?.code).toBe('USAGE_ERROR');
    expect(ctx.backend.names()).toEqual([]);
  });

  it('refuses it on a single input that is not a list', async () => {
    const ctx = fakeContext({ taskSnapshots: succeeds() });
    const err = await caught(() => runDownload(ctx, 'BV1', { allowPartial: true }, NOW));
    expect(err?.code).toBe('USAGE_ERROR');
    // Whether an input IS a list is only knowable after the parse, so this one
    // costs a classify — but still nothing queued.
    expect(ctx.backend.names()).toEqual(['parseInput']);
  });

  it('takes it on the shape it was written for', async () => {
    const videos = [{ bvid: 'BV1', title: '第一首', duration: 100 }];
    const ctx = fakeContext({
      parse: {
        items: [{ kind: 'favorites', media_id: '123', url: 'https://space.bilibili.com/x' }],
      },
      fetchList: { title: '收藏夹', videos, error: '第 7 页请求失败' },
      taskSnapshots: [snapshot({ batches: [batch()] })],
    });

    await runDownload(ctx, 'https://space.bilibili.com/x', { allowPartial: true }, NOW);
    expect(ctx.backend.names()).toContain('downloadBatch');
  });
});

describe('download — one input', () => {
  it('parses, enqueues and follows the task to the end', async () => {
    const ctx = fakeContext({ taskSnapshots: succeeds() });
    await runDownload(ctx, '周杰伦 晴天', {}, NOW);

    expect(ctx.backend.names()).toEqual([
      'parseInput',
      'downloadSong',
      'downloadTasks',
      'downloadTasks',
    ]);
    expect(ctx.backend.argsOf('downloadSong')).toEqual([{ input: '周杰伦 晴天' }]);
    expect(ctx.streams.stdout).toEqual(['✓ 完成（song song-1）']);
  });

  it('--no-wait prints the daemon envelope verbatim and never polls', async () => {
    const ctx = fakeContext({ accepted: { task_id: 'task-9' } }, { json: true });
    await runDownload(ctx, 'BV1', { wait: false }, NOW);

    expect(ctx.backend.names()).toEqual(['parseInput', 'downloadSong']);
    expect(JSON.parse(ctx.streams.stdout[0] as string)).toEqual({
      success: true,
      data: { task_id: 'task-9' },
    });
  });

  it('resolves --playlist by name and sends its id', async () => {
    const ctx = fakeContext({
      playlists: [playlist({ id: PLAYLIST_ID, name: '深夜' })],
      taskSnapshots: succeeds(),
    });
    await runDownload(ctx, 'BV1', { playlist: '深夜' }, NOW);

    const request = ctx.backend.argsOf('downloadSong')?.[0] as DownloadSongRequest;
    expect(request.playlist_id).toBe(PLAYLIST_ID);
  });

  it('--playlist all is library-only, not a playlist id', async () => {
    const ctx = fakeContext({ taskSnapshots: succeeds() });
    await runDownload(ctx, 'BV1', { playlist: 'all' }, NOW);

    const request = ctx.backend.argsOf('downloadSong')?.[0] as DownloadSongRequest;
    expect(request).toEqual({ input: 'BV1', naming_mode: 'original' });
  });

  it('a failed task is TASK_FAILED with the whole snapshot in details, stdout empty', async () => {
    const ctx = fakeContext({
      taskSnapshots: [
        snapshot({
          tasks: [
            task({
              state: 'failed',
              stage: null,
              error_code: 'SOURCE_GONE',
              error_message: '视频已被删除',
            }),
          ],
        }),
      ],
    });

    const err = await caught(() => runDownload(ctx, 'BV1', {}, NOW));
    expect(err?.code).toBe('TASK_FAILED');
    expect(err?.message).toBe('视频已被删除');
    // The task-level code travels inside `details.task` and never pretends to
    // be an envelope code (M6-6 六轮①).
    expect((err?.details?.task as DownloadTaskData).error_code).toBe('SOURCE_GONE');
    expect(ctx.streams.stdout).toEqual([]);
  });

  it('a cancelled task is TASK_CANCELLED', async () => {
    const ctx = fakeContext({
      taskSnapshots: [snapshot({ tasks: [task({ state: 'cancelled' })] })],
    });
    expect((await caught(() => runDownload(ctx, 'BV1', {}, NOW)))?.code).toBe('TASK_CANCELLED');
  });

  it('refuses a parse answer that does not line up with what was sent', async () => {
    const ctx = fakeContext({ parse: { items: [] } });
    expect((await caught(() => runDownload(ctx, 'BV1', {}, NOW)))?.code).toBe('INVALID_RESPONSE');
  });
});

describe('download — progress while waiting', () => {
  /** Transferring `received` of `total`, as one poll would see it. */
  const transferring = (received: number, total: number | null): DownloadTasksData =>
    snapshot({
      tasks: [
        task({
          state: 'running',
          stage: 'downloading',
          received_bytes: received,
          total_bytes: total,
        }),
      ],
    });

  const done = snapshot({ tasks: [task({ state: 'succeeded', result: { song_id: 'song-1' } })] });

  // Criterion 29, the terminal shape: one line that keeps being replaced.
  it('refreshes one line in a terminal, and clears it at the end', async () => {
    const ctx = fakeContext(
      {
        taskSnapshots: [
          transferring(0, 1000),
          transferring(400, 1000),
          transferring(900, 1000),
          done,
        ],
      },
      {},
      { tty: true },
    );
    await runDownload(ctx, 'BV1', {}, NOW);

    expect(ctx.streams.stderrLive).toEqual([
      '… 下载音频',
      '… 下载音频 40%',
      '… 下载音频 90%',
      // Cleared, so the outcome does not print on top of a stale percentage.
      '',
    ]);
    // Nothing was appended line by line — that is the other renderer.
    expect(ctx.streams.stderr).toEqual([]);
    expect(ctx.streams.stdout).toEqual(['✓ 完成（song song-1）']);
  });

  // …and the log shape: a line per milestone, nothing between.
  it('prints a line every tenth when stderr is not a terminal', async () => {
    const ctx = fakeContext({
      taskSnapshots: [
        transferring(0, 1000),
        transferring(20, 1000), // 2% — below the step
        transferring(150, 1000), // 15% — first step
        transferring(180, 1000), // still inside it
        transferring(400, 1000), // next step
        done,
      ],
    });
    await runDownload(ctx, 'BV1', {}, NOW);

    expect(ctx.streams.stderr).toEqual(['… 下载音频', '… 下载音频 15%', '… 下载音频 40%']);
    expect(ctx.streams.stderrLive).toEqual([]);
  });

  // The `total_bytes: null` branch: nothing to divide by, so it counts.
  it('counts megabytes when the source declared no size', async () => {
    const mb = 1024 * 1024;
    const ctx = fakeContext({
      taskSnapshots: [
        transferring(1 * mb, null),
        transferring(2 * mb, null), // under the 5MiB step, and no clock moved
        transferring(7 * mb, null),
        done,
      ],
    });
    await runDownload(ctx, 'BV1', {}, { ...NOW, now: () => 0 });

    expect(ctx.streams.stderr).toEqual(['… 下载音频 1.0MB', '… 下载音频 7.0MB']);
  });

  // A stalled transfer of unknown size still says something (§4-d).
  it('speaks up on the clock when the bytes are not moving', async () => {
    const mb = 1024 * 1024;
    let clock = 0;
    const ctx = fakeContext({
      taskSnapshots: [transferring(mb, null), transferring(mb + 1024, null), done],
    });
    const tick = (): number => {
      clock += 2000;
      return clock;
    };
    await runDownload(ctx, 'BV1', {}, { ...NOW, now: tick });

    expect(ctx.streams.stderr).toHaveLength(2);
  });

  it('says nothing at all under --json', async () => {
    const ctx = fakeContext({ taskSnapshots: [transferring(400, 1000), done] }, { json: true });
    await runDownload(ctx, 'BV1', {}, NOW);

    expect(ctx.streams.stderr).toEqual([]);
    expect(ctx.streams.stderrLive).toEqual([]);
    expect(ctx.streams.stdout).toHaveLength(1);
  });
});

describe('download — a favourites folder', () => {
  const list = {
    title: '收藏夹',
    videos: [
      { bvid: 'BV1', title: '第一首', duration: 100 },
      { bvid: 'BV2', title: '第二首', duration: 200 },
    ],
    error: null,
  };

  it('expands the list, shows it, and enqueues one batch of videos', async () => {
    const ctx = fakeContext({ fetchList: list });
    await runDownload(ctx, 'fav:123', {}, NOW);

    expect(ctx.backend.argsOf('fetchList')).toEqual([{ type: 'favorites', media_id: '123' }]);
    const groups = ctx.backend.argsOf('downloadBatch')?.[0] as DownloadBatchGroupInput[];
    expect(groups).toEqual([
      {
        target: { kind: 'all' },
        items: [
          { kind: 'video', bvid: 'BV1', page: null, title: '第一首', naming: 'original' },
          { kind: 'video', bvid: 'BV2', page: null, title: '第二首', naming: 'original' },
        ],
      },
    ]);
    expect(ctx.streams.stdout[0]).toContain('收藏夹');
    // A batch does not wait by default.
    expect(ctx.backend.names()).not.toContain('downloadTasks');
  });

  it('a collection link carries mid and season_id', async () => {
    const ctx = fakeContext({ fetchList: list });
    await runDownload(ctx, 'col:42:7', {}, NOW);
    expect(ctx.backend.argsOf('fetchList')).toEqual([
      { type: 'collection', mid: '42', season_id: '7' },
    ]);
  });

  it('refuses a partial list, and takes --allow-partial as the answer', async () => {
    const partial = { ...list, error: '列表过长，只取回了前 2 条' };

    const refused = fakeContext({ fetchList: partial });
    const err = await caught(() => runDownload(refused, 'fav:1', {}, NOW));
    expect(err?.code).toBe('BILIBILI_FAILED');
    expect(refused.backend.names()).not.toContain('downloadBatch');

    const allowed = fakeContext({ fetchList: partial });
    await runDownload(allowed, 'fav:1', { allowPartial: true }, NOW);
    expect(allowed.backend.names()).toContain('downloadBatch');
  });

  it('refuses a list bigger than one batch may carry', async () => {
    const videos = Array.from({ length: 1001 }, (_v, index) => ({
      bvid: `BV${index}`,
      title: `t${index}`,
      duration: null,
    }));
    const ctx = fakeContext({ fetchList: { title: 'x', videos, error: null } });
    expect((await caught(() => runDownload(ctx, 'fav:1', {}, NOW)))?.code).toBe('LIST_TOO_LARGE');
  });

  it('says so when the list is empty', async () => {
    const ctx = fakeContext({ fetchList: { title: 'x', videos: [], error: null } });
    expect((await caught(() => runDownload(ctx, 'fav:1', {}, NOW)))?.code).toBe('NOT_FOUND');
  });

  it('asks before enqueuing, and refuses without --yes outside a TTY', async () => {
    const ctx = fakeContext({ fetchList: list }, { yes: false });
    const err = await caught(() => runDownload(ctx, 'fav:1', {}, NOW));
    expect(err?.code).toBe('USAGE_ERROR');
    expect(ctx.backend.names()).not.toContain('downloadBatch');
  });
});

describe('download — many lines', () => {
  it('sends videos and keywords in one group, in order', async () => {
    const ctx = fakeContext();
    await runDownload(ctx, 'BV1\n# 注释\n周杰伦 晴天\nBV2', {}, NOW);

    const groups = ctx.backend.argsOf('downloadBatch')?.[0] as DownloadBatchGroupInput[];
    expect(groups[0]?.items).toEqual([
      { kind: 'video', bvid: 'BV1', page: null, title: null, naming: 'original' },
      { kind: 'keyword', query: '周杰伦 晴天' },
      { kind: 'video', bvid: 'BV2', page: null, title: null, naming: 'original' },
    ]);
  });

  it('names the lines that hold a list link instead of downloading them', async () => {
    const ctx = fakeContext();
    const err = await caught(() => runDownload(ctx, 'BV1\nfav:9\nBV2\ncol:1:2', {}, NOW));
    expect(err?.code).toBe('USAGE_ERROR');
    expect(err?.details).toEqual({ lines: [2, 4] });
    expect(ctx.backend.names()).not.toContain('downloadBatch');
  });

  it('names the lines whose keyword is too long — after the parse, not by guessing', async () => {
    // A 600-character URL is fine; a 600-character keyword is not. Only the
    // parse knows which is which.
    const long = 'x'.repeat(501);
    const ctx = fakeContext();
    const err = await caught(() => runDownload(ctx, `BV1\n${long}`, {}, NOW));
    expect(err?.code).toBe('USAGE_ERROR');
    expect(err?.details).toEqual({ lines: [2] });
  });

  it('splits the parse into requests that fit, and keeps the order', async () => {
    const inputs = Array.from({ length: 250 }, (_v, index) => `BV${index}`);
    const ctx = fakeContext();
    await runDownload(ctx, inputs.join('\n'), {}, NOW);

    const parses = ctx.backend.calls.filter((call) => call.method === 'parseInput');
    expect(parses).toHaveLength(2);
    expect((parses[0]?.args[0] as string).split('\n')).toHaveLength(200);

    const groups = ctx.backend.argsOf('downloadBatch')?.[0] as DownloadBatchGroupInput[];
    expect(groups[0]?.items).toHaveLength(250);
    expect(groups[0]?.items[249]).toEqual({
      kind: 'video',
      bvid: 'BV249',
      page: null,
      title: null,
      naming: 'original',
    });
  });

  it('--wait follows the batch and reports a clean run', async () => {
    const done = batch({
      total: 2,
      items: [
        {
          index: 0,
          task_id: 't1',
          final: { state: 'succeeded', error_code: null, song_id: 's1' },
        },
        {
          index: 1,
          task_id: 't2',
          final: { state: 'succeeded', error_code: null, song_id: 's2' },
        },
      ],
    });
    const ctx = fakeContext({
      batches: { batches: [done] },
      taskSnapshots: [snapshot({ batches: [done] })],
    });

    await runDownload(ctx, 'BV1\nBV2', { wait: true }, NOW);
    expect(ctx.streams.stdout.at(-1)).toBe('✓ 2 条全部完成');
  });

  it('--wait reports a partial failure with the per-item codes and the snapshot', async () => {
    const mixed = batch({
      total: 2,
      items: [
        {
          index: 0,
          task_id: 't1',
          final: { state: 'succeeded', error_code: null, song_id: 's1' },
        },
        {
          index: 1,
          task_id: 't2',
          final: { state: 'failed', error_code: 'FFMPEG_FAILED', song_id: null },
        },
      ],
    });
    const ctx = fakeContext({
      batches: { batches: [mixed] },
      taskSnapshots: [snapshot({ batches: [mixed] })],
    });

    const err = await caught(() => runDownload(ctx, 'BV1\nBV2', { wait: true }, NOW));
    expect(err?.code).toBe('BATCH_PARTIAL_FAILURE');
    expect(err?.message).toContain('#2 FFMPEG_FAILED');
    expect(err?.details?.batch).toEqual(mixed);
  });
});

describe('songs redownload', () => {
  it('resolves the song, enqueues, and waits by default', async () => {
    const ctx = fakeContext({
      songs: [song({ id: SONG_ID, name: '晴天' })],
      taskSnapshots: succeeds(),
    });
    await runSongsRedownload(ctx, '晴天', {}, NOW);

    expect(ctx.backend.argsOf('redownloadSong')).toEqual([SONG_ID]);
    expect(ctx.streams.stdout).toEqual(['✓ 完成（song song-1）']);
  });

  it('--no-wait returns as soon as it is queued', async () => {
    const ctx = fakeContext({ songs: [song({ id: SONG_ID, name: '晴天' })] });
    await runSongsRedownload(ctx, SONG_ID, { wait: false }, NOW);

    expect(ctx.backend.names()).toEqual(['redownloadSong']);
    expect(ctx.streams.stdout[0]).toContain('已加入队列');
  });
});

// ── 0.5.1 §7.3-e · the CLI's whole answer to multi-part ──────────────────
//
// The model used to pick a part when a link named none, and answered "1"
// whenever it could not tell. A GUI can ask; a CLI is asked on its own command
// line instead.
describe('--part / --all-parts', () => {
  const multiPart = {
    items: [{ kind: 'video', bvid: 'BV1', page: null, url: 'https://x/BV1' }],
  } as const;

  it('reads 1,3,5-7 into the pages it names', () => {
    expect(parsePartSpec('1,3,5-7')).toEqual([1, 3, 5, 6, 7]);
    // Duplicates and whitespace are somebody typing, not somebody meaning two
    // downloads of part 3.
    expect(parsePartSpec(' 3 , 1 , 3 ')).toEqual([1, 3]);
  });

  // 🔴 A mistyped spec is a usage error, not a silent part 1. Repairing it
  // quietly is the exact failure this version removed from the model.
  it.each([['0'], ['abc'], ['3-1'], [''], ['-'], ['1,x']])('refuses %s', (spec) => {
    expect(() => parsePartSpec(spec)).toThrow();
  });

  it('sends the named pages as one batch, and never touches /download/song', async () => {
    const ctx = fakeContext({ parse: multiPart, taskSnapshots: succeeds() });
    await runDownload(ctx, 'https://x/BV1', { part: '2,4' }, NOW);

    expect(ctx.backend.names()).not.toContain('downloadSong');
    expect(ctx.backend.argsOf('downloadBatch')?.[0]).toEqual([
      {
        target: { kind: 'all' },
        items: [
          { kind: 'video', bvid: 'BV1', page: 2, title: null, naming: 'original' },
          { kind: 'video', bvid: 'BV1', page: 4, title: null, naming: 'original' },
        ],
      },
    ]);
  });

  // --all-parts is the one that has to ask: nobody can write `--part 1-40`
  // without first knowing there are forty.
  it('--all-parts lists the parts first, then sends every one', async () => {
    const ctx = fakeContext({
      parse: multiPart,
      fetchParts: {
        bvid: 'BV1',
        title: '合集',
        parts: [
          { page: 1, part: '一', duration: 10 },
          { page: 2, part: '二', duration: null },
        ],
      },
      taskSnapshots: succeeds(),
    });
    await runDownload(ctx, 'https://x/BV1', { allParts: true }, NOW);

    expect(ctx.backend.argsOf('fetchParts')).toEqual(['BV1']);
    const groups = ctx.backend.argsOf('downloadBatch')?.[0] as { items: { page: number }[] }[];
    expect(groups[0]?.items.map((item) => item.page)).toEqual([1, 2]);
  });

  // The shape rules, all decided without a backend so they are exit 2 rather
  // than a request that was never going to be sent.
  it.each([
    ['--part with --batch', { part: '1', batch: 'f.txt' }],
    ['--all-parts with --batch', { allParts: true, batch: 'f.txt' }],
    ['both at once', { part: '1', allParts: true }],
    ['a bad spec', { part: '0' }],
  ])('refuses %s before any backend call', (_label, opts) => {
    expect(() => assertDownloadShape('BV1', opts)).toThrow();
  });

  it('refuses --part when the link already says ?p=', async () => {
    const ctx = fakeContext({
      parse: {
        items: [{ kind: 'video', bvid: 'BV1', page: 2, url: 'https://x/BV1?p=2' }],
      } as const,
    });
    await expect(runDownload(ctx, 'https://x/BV1?p=2', { part: '3' }, NOW)).rejects.toThrow(/冲突/);
  });

  it('refuses --part on a keyword', async () => {
    const ctx = fakeContext({ parse: { items: [{ kind: 'keyword', query: '晴天' }] } as const });
    await expect(runDownload(ctx, '晴天', { part: '1' }, NOW)).rejects.toThrow(/只对视频链接/);
  });

  // The counter-test: an ordinary link is untouched by any of this.
  it('leaves a plain link on the single path', async () => {
    const ctx = fakeContext({ taskSnapshots: succeeds() });
    await runDownload(ctx, 'BV1', {}, NOW);

    expect(ctx.backend.names()).toContain('downloadSong');
    expect(ctx.backend.names()).not.toContain('downloadBatch');
    expect(ctx.backend.names()).not.toContain('fetchParts');
  });
});
