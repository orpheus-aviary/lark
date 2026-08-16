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
