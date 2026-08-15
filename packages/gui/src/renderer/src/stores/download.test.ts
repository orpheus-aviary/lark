// Download snapshot merging, the per-task dedupe (M4-13③) and the cancelling
// overlay (M3 cancel contract).

import type { DownloadTaskData, LarkEvent } from '@lark/shared';
import { ApiError } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeTask, batchProgress, useDownloads } from './download.js';

function task(id: string, overrides: Partial<DownloadTaskData> = {}): DownloadTaskData {
  return {
    id,
    kind: 'download',
    state: 'running',
    stage: 'downloading',
    revision: 1,
    input: { type: 'keyword', query: id },
    song_id: null,
    playlist_ids: [],
    failed_playlist_ids: [],
    created_at: 1,
    started_at: 1,
    finished_at: null,
    error_code: null,
    error_message: null,
    result: null,
    received_bytes: 0,
    total_bytes: null,
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let calls: Call[] = [];
let snapshot: { tasks: DownloadTaskData[]; batches: unknown[] } = { tasks: [], batches: [] };
let cancelResponse: () => Response = () => jsonResponse({ success: true, data: task('t1') }, 200);

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (url.endsWith('/download/tasks')) {
        return Promise.resolve(jsonResponse({ success: true, data: snapshot }, 200));
      }
      if (url.endsWith('/download/cancel')) return Promise.resolve(cancelResponse());
      return Promise.resolve(jsonResponse({ success: true, data: { task_id: 'new-task' } }, 200));
    }),
  );
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  stubFetch();
  snapshot = { tasks: [], batches: [] };
  cancelResponse = () => jsonResponse({ success: true, data: task('t1') }, 200);
  useDownloads.setState({ tasks: [], batches: [], cancelling: [] });
  // The deduper is per stream, not per store instance: reset it the same way
  // a `hello` does, so one case cannot suppress the next one's events.
  useDownloads.getState().resetEventStream();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('status events', () => {
  it('updates a known task in place without refetching', async () => {
    useDownloads.setState({ tasks: [task('t1', { stage: 'analyzing', revision: 1 })] });
    useDownloads.getState().applyEvent({
      type: 'download:status',
      task_id: 't1',
      state: 'running',
      stage: 'downloading',
      revision: 2,
      received_bytes: 0,
      total_bytes: null,
    });
    await flush();

    expect(useDownloads.getState().tasks[0]?.stage).toBe('downloading');
    expect(calls.filter((call) => call.url.endsWith('/download/tasks'))).toHaveLength(0);
  });

  it('refetches when the task id is unknown', async () => {
    useDownloads.getState().applyEvent({
      type: 'download:status',
      task_id: 'unseen',
      state: 'queued',
      stage: null,
      revision: 1,
      received_bytes: 0,
      total_bytes: null,
    });
    await flush();
    expect(calls.some((call) => call.url.endsWith('/download/tasks'))).toBe(true);
  });

  it('dedupes per task, so parallel tasks with the same tuple both land', async () => {
    useDownloads.setState({
      tasks: [
        task('a', { stage: 'analyzing', revision: 1 }),
        task('b', { stage: 'analyzing', revision: 1 }),
      ],
    });
    const shared = {
      state: 'running',
      stage: 'downloading',
      revision: 2,
      received_bytes: 0,
      total_bytes: null,
    } as const;
    for (const id of ['a', 'b']) {
      useDownloads.getState().applyEvent({ type: 'download:status', task_id: id, ...shared });
    }
    // The exact repeat of task a's tuple is the one that must be dropped.
    useDownloads.setState({
      tasks: useDownloads
        .getState()
        .tasks.map((t) => (t.id === 'a' ? { ...t, stage: 'saving' } : t)),
    });
    useDownloads.getState().applyEvent({ type: 'download:status', task_id: 'a', ...shared });
    await flush();

    const byId = Object.fromEntries(useDownloads.getState().tasks.map((t) => [t.id, t.stage]));
    expect(byId.b).toBe('downloading');
    expect(byId.a).toBe('saving'); // the duplicate did not overwrite it back
  });

  it('refetches on every terminal event', async () => {
    const terminal: LarkEvent[] = [
      { type: 'download:complete', task_id: 't1', song_id: 's1' },
      { type: 'download:error', task_id: 't1', error_code: 'X', message: 'boom' },
      { type: 'download:cancelled', task_id: 't1' },
      { type: 'download:batches-changed', batch_id: 'b1' },
    ];
    for (const event of terminal) useDownloads.getState().applyEvent(event);
    await flush();
    expect(calls.filter((call) => call.url.endsWith('/download/tasks')).length).toBeGreaterThan(0);
  });
});

describe('cancelling', () => {
  it('keeps the local overlay while the task is still running', async () => {
    useDownloads.setState({ tasks: [task('t1')] });
    await useDownloads.getState().cancel('t1');

    expect(useDownloads.getState().cancelling).toEqual(['t1']);
    // The daemon answers with the task still running: the abort is set and the
    // worker settles on its own.
    expect(useDownloads.getState().tasks[0]?.state).toBe('running');
  });

  it('clears the overlay and explains a 409 in the saving stage', async () => {
    useDownloads.setState({ tasks: [task('t1', { stage: 'saving' })] });
    cancelResponse = () =>
      jsonResponse(
        { success: false, error_code: 'TASK_NOT_CANCELLABLE', message: 'too late' },
        409,
      );

    await expect(useDownloads.getState().cancel('t1')).rejects.toThrow('当前阶段不可取消');
    expect(useDownloads.getState().cancelling).toEqual([]);
  });

  it('drops the overlay once the task reaches a terminal state', async () => {
    useDownloads.setState({ tasks: [task('t1')], cancelling: ['t1'] });
    snapshot = { tasks: [task('t1', { state: 'cancelled', stage: null })], batches: [] };

    useDownloads.getState().refresh();
    await flush();

    expect(useDownloads.getState().cancelling).toEqual([]);
    expect(useDownloads.getState().tasks[0]?.state).toBe('cancelled');
  });
});

describe('requests', () => {
  it('omits playlist_id for the virtual all view (§4.1)', async () => {
    await useDownloads.getState().downloadSong('周杰伦 稻香');
    const call = calls.find((c) => c.url.endsWith('/download/song'));
    expect(call?.body).toEqual({ input: '周杰伦 稻香' });
  });

  it('sends the playlist id when one is selected', async () => {
    await useDownloads.getState().downloadSong('x', 'a4f1e3c2-0000-4000-8000-000000000001');
    const call = calls.find((c) => c.url.endsWith('/download/song'));
    expect(call?.body).toEqual({
      input: 'x',
      playlist_id: 'a4f1e3c2-0000-4000-8000-000000000001',
    });
  });

  it('imports with the field name the daemon reads', async () => {
    await useDownloads.getState().importFiles(['/tmp/a.mp3']);
    const call = calls.find((c) => c.url.endsWith('/songs/import'));
    expect(call?.body).toEqual({ file_paths: ['/tmp/a.mp3'] });
  });
});

describe('derivations', () => {
  it('picks the newest running task for the status line', () => {
    const tasks = [
      task('old', { started_at: 1 }),
      task('new', { started_at: 5 }),
      task('queued', { state: 'queued', stage: null, started_at: null }),
    ];
    expect(activeTask(tasks)?.id).toBe('new');
  });

  it('falls back to the oldest queued task', () => {
    const tasks = [
      task('later', { state: 'queued', stage: null, created_at: 9, started_at: null }),
      task('earlier', { state: 'queued', stage: null, created_at: 2, started_at: null }),
    ];
    expect(activeTask(tasks)?.id).toBe('earlier');
  });

  it('counts a batch by its settled items', () => {
    const batches = [
      {
        id: 'b1',
        target: { kind: 'all' as const },
        total: 3,
        items: [
          {
            index: 0,
            task_id: 't1',
            final: { state: 'succeeded' as const, error_code: null, song_id: 's' },
          },
          { index: 1, task_id: 't2', final: null },
          { index: 2, task_id: 't3', final: null },
        ],
        created_at: 0,
      },
    ];
    expect(batchProgress(batches, 't2')).toMatchObject({ done: 1 });
    expect(batchProgress(batches, 'unrelated')).toBeNull();
  });
});

describe('ApiError plumbing', () => {
  it('passes a non-cancel error through untouched', async () => {
    cancelResponse = () =>
      jsonResponse({ success: false, error_code: 'TASK_NOT_FOUND', message: '没有这个任务' }, 404);
    await expect(useDownloads.getState().cancel('ghost')).rejects.toBeInstanceOf(ApiError);
  });
});
