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
/** What `/download/parts` answers. One part = an ordinary video. */
let partsResult: unknown = {
  bvid: 'BV9',
  title: '单P视频',
  parts: [{ page: 1, part: '单P视频', duration: 100 }],
};
let partsResponses: (() => Response)[] = [];
const twoParts = {
  bvid: 'BV9',
  title: '古风合集',
  parts: [
    { page: 1, part: '烟雨行舟', duration: 215 },
    { page: 2, part: '半壶纱', duration: null },
  ],
};
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
  partsResult = {
    bvid: 'BV9',
    title: '单P视频',
    parts: [{ page: 1, part: '单P视频', duration: 100 }],
  };
  partsResponses = [];
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
        // 🔴 ONE PART BY DEFAULT. Every video line is asked about now (0.5.1),
        // so a stub that answered "two" for everything would turn every link
        // in this file into a group and quietly rewrite what the other
        // criteria are about.
        const next = partsResponses.shift();
        return Promise.resolve(next ? next() : jsonResponse({ success: true, data: partsResult }));
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

  // A link that already names a part needs no fetch, so the button is usable
  // on the very first render — and that is the case where Radix's own focus
  // pass runs AFTER a mount effect and puts focus back on the 原标题 checkbox.
  // Taking it in `onOpenAutoFocus` is what makes it stick.
  //
  // 🔴 `?p=` ON PURPOSE (0.5.1). A video line with no part named is asked
  // about when the dialog opens, so it is NOT instantly confirmable any more —
  // that is the cost of 「单条和多行都直接展开」, and the criterion below
  // measures it rather than letting this one quietly stop meaning anything.
  it('keeps focus on confirm for links that need no fetching', async () => {
    const user = userEvent.setup();
    const p1 = { ...video, page: 1, url: 'https://www.bilibili.com/video/BV9?p=1' } as ParsedItem;
    const p2 = {
      ...video,
      bvid: 'BV8',
      page: 2,
      url: 'https://www.bilibili.com/video/BV8?p=2',
    } as ParsedItem;
    open([p1, p2]);

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

// ── 0.5.1 · a line that turns out to be multi-part ───────────────────────
//
// Nothing offline can tell whether a video has parts, so every video line is
// asked about when the dialog opens (用户 2026-08-31：「单条和多行都直接展开」).
// What comes back decides which shape the line takes: one part and it stays a
// line, more and it becomes a GROUP — the same group a favourites folder is,
// down to the editable playlist name.
describe('a multi-part line in a paste', () => {
  it('becomes a group, exactly like a collection', async () => {
    partsResult = twoParts;
    open([video]);

    await screen.findByText('烟雨行舟');
    expect(screen.getByText('半壶纱')).toBeTruthy();
    // The group's heading is the playlist it will create, and it is editable —
    // which is the whole of what「和合集完全统一」asked for.
    expect(screen.getByTitle('双击编辑歌单名称').textContent).toContain('古风合集');
  });

  // 🔴 NOTHING IS TICKED, which is what still differs from a folder: somebody
  // who opened a folder came for the folder, while this group exists because a
  // person is choosing which parts.
  it('opens with nothing ticked, and cannot be confirmed that way', async () => {
    partsResult = twoParts;
    open([video]);
    await screen.findByText('烟雨行舟');

    expect(screen.getByRole('button', { name: /确认下载（0）/ }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('sends the ticked parts as a group of their own, into a new playlist', async () => {
    partsResult = twoParts;
    const user = userEvent.setup();
    open([video]);
    await screen.findByText('烟雨行舟');

    await user.click(screen.getByLabelText('半壶纱'));
    await user.click(screen.getByRole('button', { name: /确认下载/ }));

    await waitFor(() => expect(batchBody()).toBeDefined());
    expect(batchBody()?.groups).toEqual([
      {
        // A group creates its playlist, named after the video it came out of.
        target: { kind: 'new', name: '古风合集' },
        // NO `source`: a video is not a list, and inventing a list identity is
        // a lie the download record then repeats forever.
        items: [{ kind: 'video', bvid: 'BV9', page: 2, title: null, naming: 'clean' }],
      },
    ]);
    // It never goes back down the single path — that would just be refused.
    expect(calls.some((call) => call.url.endsWith('/download/song'))).toBe(false);
  });

  // The cost of expanding on open, stated: one request per video line. The
  // criterion exists so that changing it back to "ask nothing" is visible.
  it('asks about every video line when it opens', async () => {
    open([video, { ...video, bvid: 'BV8', url: 'https://x/BV8' }]);

    await waitFor(() =>
      expect(calls.filter((call) => call.url.endsWith('/download/parts'))).toHaveLength(2),
    );
  });

  // A link that already names a part has nothing left to choose, so it is not
  // asked about at all — the one place the cost above is not paid.
  it('does not ask about a line that already names its part', async () => {
    const p2 = { ...video, page: 2, url: 'https://www.bilibili.com/video/BV9?p=2' } as ParsedItem;
    open([p2]);

    await waitFor(() => expect(screen.getByRole('button', { name: /确认下载（1）/ })).toBeTruthy());
    expect(calls.some((call) => call.url.endsWith('/download/parts'))).toBe(false);
  });

  // 🔴 THE BACKSTOP. If the opening probe could not answer, the line stays a
  // line and the daemon refuses it at submit — and THAT path has to promote it
  // too, or the parts would arrive in a second shape. It also must not close
  // the dialog it just put the question in: 用户实测「多 P 不会被展开，会失败」
  // was exactly that, and the criterion below is the one that says so.
  it('promotes on the refusal when the opening probe failed, and stays open', async () => {
    partsResult = twoParts;
    partsResponses = [() => jsonResponse({ success: false, message: '网络错误' }, 502)];
    songResponses = [
      () =>
        jsonResponse(
          { success: false, error_code: 'MULTI_PART_UNRESOLVED', message: '这个视频有 2 个分P' },
          400,
        ),
    ];
    const user = userEvent.setup();
    const { onClose } = open([video]);

    await user.click(screen.getByRole('button', { name: /确认下载/ }));
    await screen.findByText('烟雨行舟');
    expect(onClose).not.toHaveBeenCalled();
  });

  // The other outcomes keep the shipped behaviour: it says how far it got and
  // closes. Without this the rule above could widen into "never close again".
  it('still closes when a line failed for any other reason', async () => {
    songResponses = [
      () =>
        jsonResponse({ success: false, error_code: 'DOWNLOAD_QUEUE_FULL', message: '满了' }, 409),
    ];
    const user = userEvent.setup();
    const { onClose } = open([video]);
    await waitFor(() => expect(screen.getByRole('button', { name: /确认下载（1）/ })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: /确认下载/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
