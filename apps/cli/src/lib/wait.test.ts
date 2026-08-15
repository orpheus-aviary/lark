import type { DownloadTasksData } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { batch, fakeContext, task } from '../testing/fake-backend.js';
import type { CliError } from './errors.js';
import { waitForBatch, waitForTask } from './wait.js';

/** No wall-clock time in a poll-loop test. */
const NOW: Parameters<typeof waitForTask>[2] = { sleep: () => Promise.resolve(), pollMs: 0 };

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

describe('waitForTask', () => {
  it('polls until the state is terminal and returns that snapshot', async () => {
    const ctx = fakeContext({
      taskSnapshots: [
        snapshot({ tasks: [task({ state: 'queued' })] }),
        snapshot({ tasks: [task({ state: 'running', stage: 'downloading' })] }),
        snapshot({ tasks: [task({ state: 'succeeded', result: { song_id: 'song-1' } })] }),
      ],
    });

    const finished = await waitForTask(ctx, 'task-1', NOW);
    expect(finished.state).toBe('succeeded');
    expect(ctx.backend.names()).toEqual(['downloadTasks', 'downloadTasks', 'downloadTasks']);
  });

  it('returns a failed task rather than throwing — the caller decides', async () => {
    const ctx = fakeContext({
      taskSnapshots: [snapshot({ tasks: [task({ state: 'failed', error_code: 'SOURCE_GONE' })] })],
    });
    expect((await waitForTask(ctx, 'task-1', NOW)).error_code).toBe('SOURCE_GONE');
  });

  it('reports a task that rolled out of the ring as UNKNOWN, never as failed', async () => {
    const ctx = fakeContext({ taskSnapshots: [snapshot({ tasks: [] })] });
    expect(await codeOf(() => waitForTask(ctx, 'task-1', NOW))).toBe('TASK_STATE_UNKNOWN');
  });

  it('prints one stderr line per stage change in human mode', async () => {
    const ctx = fakeContext({
      taskSnapshots: [
        snapshot({ tasks: [task({ state: 'running', stage: 'downloading' })] }),
        snapshot({ tasks: [task({ state: 'running', stage: 'downloading' })] }),
        snapshot({ tasks: [task({ state: 'running', stage: 'converting' })] }),
        snapshot({ tasks: [task({ state: 'succeeded' })] }),
      ],
    });

    await waitForTask(ctx, 'task-1', NOW);
    expect(ctx.streams.stderr).toEqual(['… 下载音频', '… 处理音频']);
    // Progress is never stdout: that one is reserved for the result.
    expect(ctx.streams.stdout).toEqual([]);
  });

  it('stays silent in --json mode', async () => {
    const ctx = fakeContext(
      {
        taskSnapshots: [
          snapshot({ tasks: [task({ state: 'running', stage: 'saving' })] }),
          snapshot({ tasks: [task({ state: 'succeeded' })] }),
        ],
      },
      { json: true },
    );

    await waitForTask(ctx, 'task-1', NOW);
    expect(ctx.streams.stderr).toEqual([]);
  });
});

describe('waitForBatch', () => {
  it('waits for every item to carry a terminal snapshot', async () => {
    const pending = batch({
      total: 2,
      items: [
        {
          index: 0,
          task_id: 'task-1',
          final: { state: 'succeeded', error_code: null, song_id: 's1' },
        },
        { index: 1, task_id: 'task-2', final: null },
      ],
    });
    const done = batch({
      total: 2,
      items: [
        {
          index: 0,
          task_id: 'task-1',
          final: { state: 'succeeded', error_code: null, song_id: 's1' },
        },
        {
          index: 1,
          task_id: 'task-2',
          final: { state: 'failed', error_code: 'FFMPEG_FAILED', song_id: null },
        },
      ],
    });
    const ctx = fakeContext({
      taskSnapshots: [snapshot({ batches: [pending] }), snapshot({ batches: [done] })],
    });

    const finished = await waitForBatch(ctx, 'batch-1', NOW);
    expect(finished.items[1]?.final?.error_code).toBe('FFMPEG_FAILED');
    expect(ctx.streams.stderr).toEqual(['… 已完成 1/2']);
  });

  it('does not call a batch finished while items are still being registered', async () => {
    // `total` is what was asked for; `items` is what the engine has registered
    // so far. An early snapshot can have one item, all of it terminal.
    const registering = batch({
      total: 2,
      items: [
        {
          index: 0,
          task_id: 'task-1',
          final: { state: 'succeeded', error_code: null, song_id: 's1' },
        },
      ],
    });
    const complete = batch({
      total: 2,
      items: [
        {
          index: 0,
          task_id: 'task-1',
          final: { state: 'succeeded', error_code: null, song_id: 's1' },
        },
        {
          index: 1,
          task_id: 'task-2',
          final: { state: 'succeeded', error_code: null, song_id: 's2' },
        },
      ],
    });
    const ctx = fakeContext({
      taskSnapshots: [snapshot({ batches: [registering] }), snapshot({ batches: [complete] })],
    });

    expect((await waitForBatch(ctx, 'batch-1', NOW)).items).toHaveLength(2);
  });

  it('reports a batch that rolled out of the ring as UNKNOWN', async () => {
    const ctx = fakeContext({ taskSnapshots: [snapshot({ batches: [] })] });
    expect(await codeOf(() => waitForBatch(ctx, 'batch-1', NOW))).toBe('TASK_STATE_UNKNOWN');
  });
});
