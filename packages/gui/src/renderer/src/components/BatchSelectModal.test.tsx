// §4.2, the part real network traffic cannot reproduce on demand: partial
// fetch-list failures, the batch endpoint's two limits, and a single-item
// submission that stops on a full queue.

import type { ParsedItem } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDownloads } from '../stores/download.js';
import { useLibrary } from '../stores/library.js';
import { BatchSelectModal } from './BatchSelectModal.js';

const PLAYLIST_ID = 'a4f1e3c2-0000-4000-8000-000000000001';

interface Call {
  url: string;
  body: unknown;
}

let calls: Call[] = [];
let fetchListResult: {
  title: string;
  videos: { bvid: string; title: string }[];
  error: string | null;
} = {
  title: '我的收藏夹',
  videos: [
    { bvid: 'BV1', title: '第一首' },
    { bvid: 'BV2', title: '第二首' },
  ],
  error: null,
};
let songResponses: (() => Response)[] = [];

function jsonResponse(body: unknown, status = 200): Response {
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
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      if (url.endsWith('/download/fetch-list')) {
        return Promise.resolve(jsonResponse({ success: true, data: fetchListResult }));
      }
      if (url.endsWith('/download/batch')) {
        return Promise.resolve(jsonResponse({ success: true, data: { batches: [] } }));
      }
      if (url.endsWith('/download/song')) {
        const next = songResponses.shift();
        return Promise.resolve(
          next ? next() : jsonResponse({ success: true, data: { task_id: 't' } }),
        );
      }
      return Promise.resolve(jsonResponse({ success: true, data: { tasks: [], batches: [] } }));
    }),
  );
}

const favorites: ParsedItem = { kind: 'favorites', media_id: '123', url: 'https://x/1' };
const video: ParsedItem = {
  kind: 'video',
  bvid: 'BV9',
  page: null,
  url: 'https://www.bilibili.com/video/BV9',
};

function open(items: readonly ParsedItem[]): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();
  render(<BatchSelectModal items={items} onClose={onClose} />);
  return { onClose };
}

const batchBody = (): { groups: { target: unknown; items: unknown[] }[] } | undefined =>
  calls.find((call) => call.url.endsWith('/download/batch'))?.body as
    | { groups: { target: unknown; items: unknown[] }[] }
    | undefined;

beforeEach(() => {
  stubFetch();
  songResponses = [];
  fetchListResult = {
    title: '我的收藏夹',
    videos: [
      { bvid: 'BV1', title: '第一首' },
      { bvid: 'BV2', title: '第二首' },
    ],
    error: null,
  };
  useDownloads.setState({ tasks: [], batches: [], cancelling: [] });
  useLibrary.setState({ playlistId: VIRTUAL_ALL_PLAYLIST_ID, search: '', songs: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('list groups', () => {
  it('submits one batch whose group creates a playlist named after the title', async () => {
    const user = userEvent.setup();
    open([favorites]);
    await screen.findByText('我的收藏夹');

    await user.click(screen.getByRole('button', { name: /确认下载/ }));
    await waitFor(() => expect(batchBody()).toBeDefined());

    expect(batchBody()?.groups).toEqual([
      {
        target: { kind: 'new', name: '我的收藏夹' },
        items: [
          { kind: 'video', bvid: 'BV1', page: null, title: null },
          { kind: 'video', bvid: 'BV2', page: null, title: null },
        ],
      },
    ]);
  });

  it('passes the list titles through only when 原标题 is ticked', async () => {
    const user = userEvent.setup();
    open([favorites]);
    await screen.findByText('我的收藏夹');

    await user.click(screen.getByLabelText('原标题'));
    await user.click(screen.getByRole('button', { name: /确认下载/ }));
    await waitFor(() => expect(batchBody()).toBeDefined());

    expect(batchBody()?.groups[0]?.items).toEqual([
      { kind: 'video', bvid: 'BV1', page: null, title: '第一首' },
      { kind: 'video', bvid: 'BV2', page: null, title: '第二首' },
    ]);
  });

  it('keeps a partially fetched list usable and says what went wrong', async () => {
    fetchListResult = {
      title: '大合集',
      videos: [{ bvid: 'BV1', title: '第一首' }],
      error: '第 7 页请求失败',
    };
    open([favorites]);

    expect(await screen.findByText(/第 7 页请求失败/)).toBeDefined();
    expect(screen.getByText(/已取回 1 条/)).toBeDefined();
    expect(screen.getByLabelText('第一首')).toBeDefined();
    expect(screen.getByRole('button', { name: /确认下载（1）/ })).toBeDefined();
  });

  it('drops a group whose items are all unticked', async () => {
    const user = userEvent.setup();
    open([favorites, video]);
    await screen.findByText('我的收藏夹');

    await user.click(screen.getByRole('button', { name: '全不选' }));
    await user.click(screen.getByRole('button', { name: /确认下载/ }));

    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/download/song'))).toBe(true),
    );
    // No group left, so the batch endpoint is skipped entirely (§4.2).
    expect(batchBody()).toBeUndefined();
  });

  it('blocks a submission over the batch item limit instead of splitting it', async () => {
    fetchListResult = {
      title: '巨型收藏夹',
      videos: Array.from({ length: 1001 }, (_, i) => ({ bvid: `BV${i}`, title: `t${i}` })),
      error: null,
    };
    open([favorites]);
    await screen.findByText('巨型收藏夹');

    expect(await screen.findByText(/一次最多 1000 个视频/)).toBeDefined();
    expect(screen.getByRole('button', { name: /确认下载/ }).hasAttribute('disabled')).toBe(true);
  });
});

describe('single items', () => {
  it('submits them one at a time after the batch, into the current playlist', async () => {
    const user = userEvent.setup();
    useLibrary.setState({ playlistId: PLAYLIST_ID });
    open([video]);

    await user.click(screen.getByRole('button', { name: /确认下载/ }));
    await waitFor(() =>
      expect(calls.filter((call) => call.url.endsWith('/download/song'))).toHaveLength(1),
    );
    expect(calls.find((call) => call.url.endsWith('/download/song'))?.body).toEqual({
      input: 'https://www.bilibili.com/video/BV9',
      playlist_id: PLAYLIST_ID,
    });
  });

  it('stops at the first refusal and says how far it got', async () => {
    const user = userEvent.setup();
    songResponses = [
      () => jsonResponse({ success: true, data: { task_id: 't1' } }),
      () => jsonResponse({ success: false, error_code: 'QUEUE_FULL', message: '队列已满' }, 429),
    ];
    const second: ParsedItem = { ...video, bvid: 'BV8', url: 'https://www.bilibili.com/video/BV8' };
    const third: ParsedItem = { ...video, bvid: 'BV7', url: 'https://www.bilibili.com/video/BV7' };
    const { onClose } = open([video, second, third]);

    const errorToast = vi.spyOn(toast, 'error');
    await user.click(screen.getByRole('button', { name: /确认下载/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // The third was never attempted, and the report says 1 of 3 went in.
    expect(calls.filter((call) => call.url.endsWith('/download/song'))).toHaveLength(2);
    expect(errorToast).toHaveBeenCalledWith(expect.stringContaining('已提交 1/3'));
    errorToast.mockRestore();
  });
});
