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
import { useMediaTools } from '../stores/media-tools.js';
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
      if (url.endsWith('/download/parts')) {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              bvid: 'BV9',
              title: '古风合集',
              parts: [
                { page: 1, part: '烟雨行舟', duration: 215 },
                { page: 2, part: '半壶纱', duration: null },
              ],
            },
          }),
        );
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

function open(items: readonly ParsedItem[]): {
  onClose: ReturnType<typeof vi.fn>;
  onBack: ReturnType<typeof vi.fn>;
} {
  const onClose = vi.fn();
  const onBack = vi.fn();
  render(<BatchSelectModal items={items} onClose={onClose} onBack={onBack} />);
  return { onClose, onBack };
}

const batchBody = (): { groups: { target: unknown; items: unknown[] }[] } | undefined =>
  calls.find((call) => call.url.endsWith('/download/batch'))?.body as
    | { groups: { target: unknown; items: unknown[] }[] }
    | undefined;

beforeEach(() => {
  stubFetch();
  // The naming default is remembered between submissions (§4-e), so a test
  // that ticks the box would otherwise decide what the next one starts with.
  localStorage.clear();
  useMediaTools.setState({ llmAvailable: null });
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

describe('the keyboard path', () => {
  // The same shape the single-link question has: the answer holds focus, so a
  // list that came back ready is one Enter away.
  it('gives the confirm button focus once the list has arrived, and Enter submits', async () => {
    const user = userEvent.setup();
    open([favorites]);
    await screen.findByText('我的收藏夹');

    const confirm = screen.getByRole('button', { name: /确认下载/ });
    await waitFor(() => expect(document.activeElement).toBe(confirm));

    // Behavioural, because a focus assertion alone passes on the frame BEFORE
    // Radix's own focus pass takes it back to the first checkbox.
    await user.keyboard('{Enter}');
    await waitFor(() => expect(batchBody()).toBeDefined());
    expect(document.activeElement).toBe(confirm);
  });

  // Plain links need no fetch, so the button is usable on the very first
  // render — and that is the case where Radix's own focus pass runs AFTER a
  // mount effect and puts focus back on the 原标题 checkbox. Taking it in
  // `onOpenAutoFocus` is what makes it stick.
  it('keeps focus on confirm for links that need no fetching', async () => {
    const user = userEvent.setup();
    open([video, { ...video, bvid: 'BV8', url: 'https://www.bilibili.com/video/BV8' }]);

    const confirm = screen.getByRole('button', { name: /确认下载/ });
    expect(document.activeElement).toBe(confirm);

    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/download/song'))).toBe(true),
    );
  });

  // A disabled button cannot hold focus, and the list is still loading when
  // the dialog opens — so "focus on open" alone would have missed.
  it('does not take focus while the list is still loading', () => {
    open([favorites]);
    expect(screen.getByRole('button', { name: /确认下载/ }).hasAttribute('disabled')).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: /确认下载/ }));
  });
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
        // ④ — and the name is the one on screen, which is also the playlist's,
        // so 「from：我的收藏夹」 and the playlist agree.
        source: { list: 'favorites', title: '我的收藏夹', url: 'https://x/1' },
        items: [
          { kind: 'video', bvid: 'BV1', page: null, title: '第一首', naming: 'clean' },
          { kind: 'video', bvid: 'BV2', page: null, title: '第二首', naming: 'clean' },
        ],
      },
    ]);
  });

  // Criterion 23. The checkbox used to send `title: null` when unticked, which
  // on a favourites folder is the SAME name the daemon would have used anyway
  // — the two branches were indistinguishable at the wire. Now they differ in
  // the field that decides, and the title rides along either way (it is what
  // cleaning reads the song name out of).
  it('produces two different requests from the two checkbox states', async () => {
    const user = userEvent.setup();
    open([favorites]);
    await screen.findByText('我的收藏夹');

    await user.click(screen.getByLabelText('原标题'));
    await user.click(screen.getByRole('button', { name: /确认下载/ }));
    await waitFor(() => expect(batchBody()).toBeDefined());

    expect(batchBody()?.groups[0]?.items).toEqual([
      { kind: 'video', bvid: 'BV1', page: null, title: '第一首', naming: 'original' },
      { kind: 'video', bvid: 'BV2', page: null, title: '第二首', naming: 'original' },
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
      naming_mode: 'clean',
    });
  });

  // The other half of criterion 24: the dialog asks once, for every link item
  // in the submission, and the answer rides on each request.
  it('applies one naming answer to every link item', async () => {
    const user = userEvent.setup();
    const second: ParsedItem = { ...video, bvid: 'BV8', url: 'https://www.bilibili.com/video/BV8' };
    open([video, second]);

    await user.click(screen.getByLabelText('原标题'));
    await user.click(screen.getByRole('button', { name: /确认下载/ }));

    await waitFor(() =>
      expect(calls.filter((call) => call.url.endsWith('/download/song'))).toHaveLength(2),
    );
    for (const call of calls.filter((c) => c.url.endsWith('/download/song'))) {
      expect((call.body as { naming_mode: string }).naming_mode).toBe('original');
    }
  });

  it('sends no naming for a keyword item', async () => {
    const user = userEvent.setup();
    const keyword: ParsedItem = { kind: 'keyword', query: '稻香' };
    open([keyword]);

    await user.click(screen.getByRole('button', { name: /确认下载/ }));

    await waitFor(() =>
      expect(calls.find((call) => call.url.endsWith('/download/song'))?.body).toEqual({
        input: '稻香',
      }),
    );
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

// ② — the way out that is not a submission hands the text back rather than
// dropping it. There is exactly one such button: cancelling outright is a
// misclick away from a list somebody just pasted.
describe('backing out', () => {
  it('offers one way out, and it goes back rather than closing', async () => {
    const user = userEvent.setup();
    const { onClose, onBack } = open([video]);

    const buttons = screen
      .getAllByRole('button')
      .filter((button) => /^(返回|取消|确认下载)/.test(button.textContent ?? ''));
    expect(buttons.map((button) => button.textContent)).toEqual([
      '返回',
      expect.stringMatching(/^确认下载/),
    ]);

    await user.click(screen.getByRole('button', { name: '返回' }));
    expect(onBack).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('treats Escape as backing out too', async () => {
    const user = userEvent.setup();
    const { onClose, onBack } = open([video]);

    await user.keyboard('{Escape}');
    expect(onBack).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ── 0.5.1 §7.3-c · a pasted line that turns out to be multi-part ──────────
//
// Twenty pasted links must not cost twenty page-list requests, so nothing is
// expanded up front. The daemon's refusal is what expands the one line that
// needs it, in place, where the person can see which line it was.
describe('a multi-part line in a paste', () => {
  const refuseMultiPart = () =>
    jsonResponse(
      {
        success: false,
        error_code: 'MULTI_PART_UNRESOLVED',
        message: '这个视频有 2 个分P',
      },
      400,
    );

  it('expands the line instead of failing it', async () => {
    songResponses = [refuseMultiPart];
    const user = userEvent.setup();
    open([video]);
    await user.click(screen.getByRole('button', { name: /确认/ }));

    await screen.findByText('烟雨行舟');
    expect(screen.getByText('半壶纱')).toBeTruthy();
    // The line now reads as what it turned out to be.
    expect(screen.getByText('古风合集')).toBeTruthy();
  });

  it('costs nothing until the refusal — no line is expanded up front', async () => {
    const user = userEvent.setup();
    open([video, video]);
    // Opening the dialog asks bilibili nothing about either line.
    await waitFor(() => expect(screen.getByRole('button', { name: /确认/ })).toBeTruthy());
    expect(calls.some((call) => call.url.endsWith('/download/parts'))).toBe(false);
    await user.click(screen.getByRole('button', { name: /确认/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/download/song'))).toBe(true));
    expect(calls.some((call) => call.url.endsWith('/download/parts'))).toBe(false);
  });

  it('sends the ticked parts as their own group on the next confirm', async () => {
    songResponses = [refuseMultiPart];
    const user = userEvent.setup();
    open([video]);
    await user.click(screen.getByRole('button', { name: /确认/ }));
    await screen.findByText('烟雨行舟');

    await user.click(screen.getByLabelText('烟雨行舟'));
    // The parts inherit the dialog's own naming answer rather than carrying a
    // second one: it is the same submission, and being asked twice reads as a
    // bug (§7.3, 用户: 和合集一致).
    await user.click(screen.getByLabelText('原标题'));
    await user.click(screen.getByRole('button', { name: /确认/ }));

    await waitFor(() => expect(batchBody()).toBeDefined());
    expect(batchBody()?.groups).toEqual([
      {
        target: { kind: 'all' },
        items: [{ kind: 'video', bvid: 'BV9', page: 1, title: null, naming: 'original' }],
      },
    ]);
    // The expanded line does NOT go back down the single path — sending the
    // whole link again would just be refused again.
    expect(calls.filter((call) => call.url.endsWith('/download/song'))).toHaveLength(1);
  });
});
