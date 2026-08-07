// The paste-one-line flow (D17) and the cancel affordance's saving-stage rule.

import type { DownloadTaskData } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDownloads } from '../stores/download.js';
import { useLibrary } from '../stores/library.js';
import { DownloadBar } from './DownloadBar.js';

interface Call {
  url: string;
  body: unknown;
}

let calls: Call[] = [];
let parseResult: (() => Response) | null = null;

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
    input: { type: 'keyword', query: '稻香' },
    song_id: null,
    playlist_ids: [],
    failed_playlist_ids: [],
    created_at: 1,
    started_at: 1,
    finished_at: null,
    error_code: null,
    error_message: null,
    result: null,
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  parseResult = null;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.endsWith('/download/parse') && parseResult) return Promise.resolve(parseResult());
      if (url.endsWith('/download/song')) {
        return Promise.resolve(jsonResponse({ success: true, data: { task_id: 't1' } }));
      }
      if (url.endsWith('/download/fetch-list')) {
        return Promise.resolve(
          jsonResponse({ success: true, data: { title: '收藏夹', videos: [], error: null } }),
        );
      }
      if (url.endsWith('/download/cancel')) {
        // The daemon answers with the task itself, usually still running.
        return Promise.resolve(jsonResponse({ success: true, data: task() }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: { tasks: [], batches: [] } }));
    }),
  );
  useDownloads.setState({ tasks: [], batches: [], cancelling: [] });
  useLibrary.setState({
    playlistId: VIRTUAL_ALL_PLAYLIST_ID,
    search: '',
    songs: [],
    selectedIds: [],
    selectionAnchor: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('one line of input', () => {
  it('sends a lone video straight to /download/song with the normalised url', async () => {
    const user = userEvent.setup();
    parseResult = () =>
      jsonResponse({
        success: true,
        data: {
          items: [
            { kind: 'video', bvid: 'BV1', page: 2, url: 'https://www.bilibili.com/video/BV1?p=2' },
          ],
        },
      });
    render(<DownloadBar />);

    await user.type(screen.getByLabelText('下载链接或歌曲名称'), 'BV1{Enter}');

    await waitFor(() =>
      expect(calls.find((call) => call.url.endsWith('/download/song'))?.body).toEqual({
        input: 'https://www.bilibili.com/video/BV1?p=2',
      }),
    );
  });

  it('opens the selection dialog for anything with more than one item', async () => {
    const user = userEvent.setup();
    parseResult = () =>
      jsonResponse({
        success: true,
        data: {
          items: [
            { kind: 'favorites', media_id: '1', url: 'https://x/1' },
            { kind: 'keyword', query: '稻香' },
          ],
        },
      });
    render(<DownloadBar />);

    await user.type(screen.getByLabelText('下载链接或歌曲名称'), 'blob{Enter}');

    expect(await screen.findByRole('dialog')).toBeDefined();
    expect(screen.getByText(/批量下载/)).toBeDefined();
    expect(calls.some((call) => call.url.endsWith('/download/song'))).toBe(false);
  });

  it('shows the reason when nothing was recognised', async () => {
    const user = userEvent.setup();
    parseResult = () => jsonResponse({ success: true, data: { items: [] } });
    render(<DownloadBar />);

    await user.type(screen.getByLabelText('下载链接或歌曲名称'), '???{Enter}');
    expect(await screen.findByText('未识别到有效的下载项')).toBeDefined();
  });

  it('surfaces a parse failure from the daemon', async () => {
    const user = userEvent.setup();
    parseResult = () =>
      jsonResponse(
        { success: false, error_code: 'INVALID_SOURCE', message: '无法识别的链接' },
        400,
      );
    render(<DownloadBar />);

    await user.type(screen.getByLabelText('下载链接或歌曲名称'), 'http://evil{Enter}');
    expect(await screen.findByText('无法识别的链接')).toBeDefined();
  });
});

describe('status line', () => {
  it('shows the stage and the batch counter', async () => {
    useDownloads.setState({
      tasks: [task()],
      batches: [
        {
          id: 'b1',
          target: { kind: 'all' },
          total: 3,
          items: [
            { index: 0, task_id: 't1', final: null },
            {
              index: 1,
              task_id: 't2',
              final: { state: 'succeeded', error_code: null, song_id: 's' },
            },
            { index: 2, task_id: 't3', final: null },
          ],
          created_at: 0,
        },
      ],
    });
    render(<DownloadBar />);

    expect(await screen.findByText('下载中')).toBeDefined();
    expect(screen.getByText('1/3')).toBeDefined();
  });

  it('disables cancel once the task is saving', () => {
    useDownloads.setState({ tasks: [task({ stage: 'saving' })] });
    render(<DownloadBar />);

    expect(screen.getByRole('button', { name: '取消下载' }).hasAttribute('disabled')).toBe(true);
  });

  it('marks a cancelling task and keeps the button disabled', async () => {
    const user = userEvent.setup();
    useDownloads.setState({ tasks: [task()] });
    render(<DownloadBar />);

    await user.click(screen.getByRole('button', { name: '取消下载' }));

    expect(await screen.findByText(/取消中/)).toBeDefined();
    expect(screen.getByRole('button', { name: '取消下载' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('the batch action bar shares this row (S3/B-5)', () => {
  const PLAYLIST = 'a4f1e3c2-0000-4000-8000-000000000001';

  it('takes the row over from the download status while a selection exists', async () => {
    useDownloads.setState({ tasks: [task()], batches: [], cancelling: [] });
    render(<DownloadBar />);
    expect(screen.getByText('下载中')).toBeDefined();

    useLibrary.setState({ selectedIds: ['song-1', 'song-2'] });
    expect(await screen.findByText('已选 2 首')).toBeDefined();
    // The download did not stop — its progress just lives in the popover now.
    expect(screen.queryByText('下载中')).toBeNull();

    useLibrary.setState({ selectedIds: [] });
    expect(await screen.findByText('下载中')).toBeDefined();
  });

  it('offers "remove from this list" only inside a real playlist (B-9)', async () => {
    useLibrary.setState({ selectedIds: ['song-1'], playlistId: VIRTUAL_ALL_PLAYLIST_ID });
    const { rerender } = render(<DownloadBar />);
    expect(screen.queryByRole('button', { name: '从当前列表移除' })).toBeNull();

    useLibrary.setState({ playlistId: PLAYLIST, search: '' });
    rerender(<DownloadBar />);
    expect(screen.getByRole('button', { name: '从当前列表移除' })).toBeDefined();

    // A search result spans the library, so it is not a member list.
    useLibrary.setState({ search: '周' });
    rerender(<DownloadBar />);
    expect(screen.queryByRole('button', { name: '从当前列表移除' })).toBeNull();
  });

  it('pins the whole selection from the bar', async () => {
    const user = userEvent.setup();
    useLibrary.setState({ selectedIds: ['song-1', 'song-2'] });
    render(<DownloadBar />);

    await user.click(screen.getByRole('button', { name: '固定' }));

    await waitFor(() => {
      const pins = calls.filter((c) => c.url.includes('/pin'));
      expect(pins).toHaveLength(2);
      expect(pins[0]?.body).toEqual({ pinned: true });
    });
  });

  it('clears the selection from the ✕', async () => {
    const user = userEvent.setup();
    useLibrary.setState({ selectedIds: ['song-1'] });
    render(<DownloadBar />);

    await user.click(screen.getByRole('button', { name: '清空选择' }));

    expect(useLibrary.getState().selectedIds).toEqual([]);
  });
});
