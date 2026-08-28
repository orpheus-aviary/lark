// The download panel (§3.6-3 — criterion 30). Three sections, three verbs,
// and the per-task answer `cancel-all` gives back.

import type { DownloadRecord } from '@lark/core/portable';
import type { DownloadTaskData } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDownloads } from '../stores/download.js';
import { DownloadPanel } from './DownloadPanel.js';

interface Call {
  url: string;
  method: string;
}

let calls: Call[] = [];
/** What `GET /download/history` answers — the panel refetches when it opens. */
let historyResponse: DownloadRecord[] = [];
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

function record(overrides: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id: 'd1',
    kind: 'download',
    state: 'succeeded',
    title: null,
    artist: null,
    input: { type: 'url', url: 'https://www.bilibili.com/video/BV1' },
    origin: { kind: 'video', url: 'https://www.bilibili.com/video/BV1' },
    playlist_ids: [],
    song_id: null,
    error_code: null,
    error_message: null,
    finished_at: 1,
    ...overrides,
  };
}

/**
 * Seed the record BOTH places: the panel refetches when it opens, so a state
 * the daemon does not also answer with is wiped a tick later.
 */
const seedHistory = (records: readonly DownloadRecord[]): void => {
  historyResponse = [...records];
  useDownloads.setState({ history: records });
};

beforeEach(() => {
  calls = [];
  historyResponse = [];
  cancelAllResult = { cancelled: 2, results: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.endsWith('/download/history')) {
        return Promise.resolve(jsonResponse({ success: true, data: { records: historyResponse } }));
      }
      if (url.endsWith('/download/cancel-all')) {
        return Promise.resolve(jsonResponse({ success: true, data: cancelAllResult }));
      }
      if (url.endsWith('/download/tasks')) {
        return Promise.resolve(jsonResponse({ success: true, data: { tasks: [], batches: [] } }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    }),
  );
  useDownloads.setState({ tasks: [], batches: [], cancelling: [], history: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const open = (): void => {
  render(<DownloadPanel open onClose={() => {}} />);
};

// ④ — every row says where it came from, and hands that over on request.
describe('where a download came from', () => {
  it('counts an entry inside the list it was picked out of', () => {
    useDownloads.setState({
      tasks: [
        task({
          origin: {
            kind: 'list',
            list: 'collection',
            title: '华语经典',
            url: 'https://space.bilibili.com/1/lists/9',
            video_url: 'https://www.bilibili.com/video/BV3?p=2',
            index: 3,
            total: 50,
          },
        }),
      ],
    });
    open();

    expect(screen.getByText('from：华语经典（3/50）')).toBeDefined();
  });

  // The label names the list; the button copies the ONE video, which is the
  // link that reproduces this song.
  it('copies the entry rather than the list', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    useDownloads.setState({
      tasks: [
        task({
          origin: {
            kind: 'list',
            list: 'collection',
            title: '华语经典',
            url: 'https://space.bilibili.com/1/lists/9',
            video_url: 'https://www.bilibili.com/video/BV3?p=2',
            index: 3,
            total: 50,
          },
        }),
      ],
    });
    open();

    await user.click(screen.getByRole('button', { name: /复制来源/ }));
    expect(writeText).toHaveBeenCalledWith('https://www.bilibili.com/video/BV3?p=2');
  });

  // A redownload started from a song already here: there is a line to read and
  // nothing a clipboard could hold.
  it('offers no copy button where there is no link', () => {
    useDownloads.setState({
      tasks: [task({ kind: 'redownload', origin: { kind: 'song', song_id: 's1' } })],
    });
    open();

    expect(screen.getByText('from：曲库里已有的歌')).toBeDefined();
    expect(screen.queryByRole('button', { name: /复制来源/ })).toBeNull();
  });
});

describe('the three sections', () => {
  it('splits running, queued and finished', () => {
    useDownloads.setState({
      tasks: [
        task({ id: 'r', state: 'running', stage: 'downloading' }),
        task({ id: 'q', state: 'queued', stage: null }),
      ],
    });
    // 已结束 is the daemon's file now, not a filter over the two above.
    seedHistory([record({ id: 'd' })]);
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
    seedHistory([
      record({ id: 'dl', kind: 'download', title: '稻香', artist: '周杰伦' }),
      record({
        id: 'lrc',
        kind: 'lyrics',
        title: '稻香',
        artist: '周杰伦',
        input: { type: 'song', song_id: 's1' },
        origin: { kind: 'song', song_id: 's1' },
      }),
    ]);
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

  it('runs the live sections as a queue, and shows the record as it arrives', () => {
    useDownloads.setState({
      tasks: [
        // Deliberately shuffled: the store holds them in arrival order, which
        // is not the order either live section wants.
        //
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
    // Newest first, and NOT re-sorted here: `ordered()` in portable decides
    // that once, for both hosts, and re-deciding it would be a second answer.
    seedHistory([
      record({ id: 'f-new', title: 'f-new', finished_at: 30 }),
      record({ id: 'f-old', title: 'f-old', finished_at: 10 }),
    ]);
    open();

    expect(names()).toEqual(['r-early', 'r-late', 'q-early', 'q-late', 'f-new', 'f-old']);
  });
});

// P8c — 已结束 is the daemon's file, not a filter over the live snapshot.
describe('the record', () => {
  it('reads it from the daemon when the panel opens', async () => {
    seedHistory([record({ id: 'd', title: '上一次启动' })]);
    open();

    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/download/history'))).toBe(true),
    );
    expect(screen.getByText('上一次启动')).toBeDefined();
  });

  // The whole point of the file: this row belongs to no task the engine still
  // holds, and it is on screen anyway.
  it('shows a row no live task corresponds to', () => {
    useDownloads.setState({ tasks: [] });
    seedHistory([record({ id: 'gone', title: '上周下的', state: 'failed' })]);
    open();

    expect(screen.getByText('上周下的')).toBeDefined();
    expect(screen.getByRole('heading', { name: '已结束' })).toBeDefined();
  });
});

describe('the two verbs', () => {
  // §3.6-3 froze the words: a TASK is cancelled, a RECORD is cleared, and
  // deleting a song is not something this panel offers at all.
  // It used to hide rows in this window, because the only record there was
  // lived in the engine's ring. There is a file now, so clearing it is a
  // DELETE — and a row hidden from one window would be the lie.
  it('clears records for real, without touching what is still running', async () => {
    const user = userEvent.setup();
    useDownloads.setState({ tasks: [task({ id: 'r', state: 'running' })] });
    seedHistory([record({ id: 'd' })]);
    open();

    await user.click(screen.getByRole('button', { name: '清除记录' }));

    await waitFor(() =>
      expect(
        calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/download/history')),
      ).toBe(true),
    );
    expect(screen.queryByRole('heading', { name: '已结束' })).toBeNull();
    expect(screen.getByRole('heading', { name: '进行中' })).toBeDefined();
  });

  it('disables each button when it has nothing to act on', () => {
    seedHistory([record({ id: 'd' })]);
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
