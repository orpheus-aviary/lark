// The download panel (§3.6-3 — criterion 30). Three sections, three verbs,
// and the per-task answer `cancel-all` gives back.

import type { DownloadTaskData } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDownloads } from '../stores/download.js';
import { DownloadPanel } from './DownloadPanel.js';

interface Call {
  url: string;
}

let calls: Call[] = [];
let cancelAllResult: unknown = { cancelled: 2, results: [] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function task(overrides: Partial<DownloadTaskData> = {}): DownloadTaskData {
  return {
    id: 't1',
    kind: 'download',
    state: 'running',
    stage: 'downloading',
    revision: 1,
    input: { type: 'url', url: 'https://www.bilibili.com/video/BV1' },
    origin: { kind: 'video', url: 'https://www.bilibili.com/video/BV1' },
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
    title: null,
    artist: null,
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  cancelAllResult = { cancelled: 2, results: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      calls.push({ url });
      if (url.endsWith('/download/cancel-all')) {
        return Promise.resolve(jsonResponse({ success: true, data: cancelAllResult }));
      }
      if (url.endsWith('/download/tasks')) {
        return Promise.resolve(jsonResponse({ success: true, data: { tasks: [], batches: [] } }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    }),
  );
  useDownloads.setState({ tasks: [], batches: [], cancelling: [], dismissed: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const open = (): void => {
  render(<DownloadPanel open onClose={() => {}} />);
};

describe('the three sections', () => {
  it('splits running, queued and finished', () => {
    useDownloads.setState({
      tasks: [
        task({ id: 'r', state: 'running', stage: 'downloading' }),
        task({ id: 'q', state: 'queued', stage: null }),
        task({ id: 'd', state: 'succeeded', stage: null }),
      ],
    });
    open();

    expect(screen.getByRole('heading', { name: '进行中' })).toBeDefined();
    expect(screen.getByRole('heading', { name: '排队中' })).toBeDefined();
    expect(screen.getByRole('heading', { name: '已结束' })).toBeDefined();
  });

  it('shows a section only when it has something in it', () => {
    useDownloads.setState({ tasks: [task({ id: 'q', state: 'queued', stage: null })] });
    open();

    expect(screen.getByRole('heading', { name: '排队中' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: '进行中' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '已结束' })).toBeNull();
  });

  it('carries the transfer into the row', () => {
    useDownloads.setState({
      tasks: [task({ received_bytes: 400, total_bytes: 1000 })],
    });
    open();
    expect(screen.getByText('下载音频 40%')).toBeDefined();
  });
});

describe('what a row is called', () => {
  it('says the song once it has a name, and the link until then', () => {
    useDownloads.setState({
      tasks: [
        task({ id: 'named', title: '稻香', artist: '周杰伦' }),
        task({ id: 'unnamed', state: 'queued', stage: null }),
      ],
    });
    open();

    // The name replaces the URL — that is the whole point — but the URL is
    // still the honest answer for a link nobody has resolved yet.
    expect(screen.getByText('稻香')).toBeDefined();
    expect(screen.getByText('· 周杰伦')).toBeDefined();
    expect(screen.getByText('https://www.bilibili.com/video/BV1')).toBeDefined();
  });

  // One link produces two tasks — the download and the lyrics fetch it spawns
  // — and since both carry the song's name, the name alone makes them the same
  // row twice.
  it('tells a download apart from the lyrics fetch it spawned', () => {
    const finished = {
      state: 'succeeded',
      stage: null,
      title: '稻香',
      artist: '周杰伦',
    } as const;
    useDownloads.setState({
      tasks: [
        task({ id: 'dl', kind: 'download', finished_at: 2, ...finished }),
        task({
          id: 'lrc',
          kind: 'lyrics',
          input: { type: 'song', song_id: 's1' },
          finished_at: 3,
          ...finished,
        }),
      ],
    });
    open();

    expect(screen.getAllByText('稻香')).toHaveLength(2);
    expect(screen.getByText('歌词')).toBeDefined();
    // The plain download carries no tag: it is what this panel is about.
    expect(screen.queryByText('下载')).toBeNull();
  });

  it('does not print an empty artist as a bare separator', () => {
    useDownloads.setState({ tasks: [task({ title: '无人声', artist: '' })] });
    open();
    expect(screen.queryByText('·', { exact: false })).toBeNull();
  });
});

describe('the order within each section', () => {
  /** The first line of each row, which is where the title lives. */
  const names = (): string[] =>
    screen.getAllByRole('listitem').map((row) => row.querySelector('p')?.textContent ?? '');

  it('runs the live sections as a queue and the finished one as a log', () => {
    useDownloads.setState({
      tasks: [
        // Deliberately shuffled: the store holds them in arrival order, which
        // is not the order any of the three sections wants.
        task({ id: 'f-old', title: 'f-old', state: 'succeeded', stage: null, finished_at: 10 }),
        // A queued task has no `started_at` — that is what makes `created_at`
        // the queue's own order.
        task({
          id: 'q-late',
          title: 'q-late',
          state: 'queued',
          stage: null,
          created_at: 40,
          started_at: null,
        }),
        task({ id: 'f-new', title: 'f-new', state: 'failed', stage: null, finished_at: 30 }),
        task({
          id: 'q-early',
          title: 'q-early',
          state: 'queued',
          stage: null,
          created_at: 20,
          started_at: null,
        }),
        task({ id: 'r-late', title: 'r-late', state: 'running', started_at: 15 }),
        task({ id: 'r-early', title: 'r-early', state: 'running', started_at: 5 }),
      ],
    });
    open();

    expect(names()).toEqual(['r-early', 'r-late', 'q-early', 'q-late', 'f-new', 'f-old']);
  });

  it('orders a cancelled task that never finished by when it was submitted', () => {
    useDownloads.setState({
      tasks: [
        task({
          id: 'a',
          title: 'a',
          state: 'cancelled',
          stage: null,
          created_at: 1,
          finished_at: null,
        }),
        task({
          id: 'b',
          title: 'b',
          state: 'succeeded',
          stage: null,
          created_at: 2,
          finished_at: 2,
        }),
      ],
    });
    open();
    expect(names()).toEqual(['b', 'a']);
  });
});

describe('the two verbs', () => {
  // §3.6-3 froze the words: a TASK is cancelled, a RECORD is cleared, and
  // deleting a song is not something this panel offers at all.
  it('clears records without touching what is still running', async () => {
    const user = userEvent.setup();
    useDownloads.setState({
      tasks: [
        task({ id: 'r', state: 'running' }),
        task({ id: 'd', state: 'succeeded', stage: null }),
      ],
    });
    open();

    await user.click(screen.getByRole('button', { name: '清除记录' }));

    expect(useDownloads.getState().dismissed).toEqual(['d']);
    // Nothing was asked of the daemon: the record is this window's.
    expect(calls).toEqual([]);
    expect(screen.queryByRole('heading', { name: '已结束' })).toBeNull();
    expect(screen.getByRole('heading', { name: '进行中' })).toBeDefined();
  });

  it('disables each button when it has nothing to act on', () => {
    useDownloads.setState({ tasks: [task({ id: 'd', state: 'succeeded', stage: null })] });
    open();

    expect(screen.getByRole('button', { name: '全部取消' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '清除记录' }).hasAttribute('disabled')).toBe(false);
  });

  it('reports what cancel-all actually managed', async () => {
    const user = userEvent.setup();
    const success = vi.spyOn(toast, 'success');
    cancelAllResult = {
      cancelled: 1,
      results: [
        { task_id: 'a', state: 'cancelled', error_code: null },
        // Past the commit point: refused, and that is a finished download
        // rather than a failure to obey.
        { task_id: 'b', state: 'running', error_code: 'TASK_NOT_CANCELLABLE' },
      ],
    };
    useDownloads.setState({
      tasks: [task({ id: 'a', state: 'queued', stage: null }), task({ id: 'b', stage: 'saving' })],
    });
    open();

    await user.click(screen.getByRole('button', { name: '全部取消' }));

    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/download/cancel-all'))).toBe(true),
    );
    expect(success).toHaveBeenCalledWith('已取消 1 个任务，1 个已经过了可取消的阶段');
    success.mockRestore();
  });
});
