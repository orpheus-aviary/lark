// The paste-one-line flow (D17) and the cancel affordance's saving-stage rule.

import type { DownloadTaskData } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDownloads } from '../stores/download.js';
import { useLibrary } from '../stores/library.js';
import { useMediaTools } from '../stores/media-tools.js';
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
    received_bytes: 0,
    total_bytes: null,
    title: null,
    artist: null,
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
  useMediaTools.setState({ info: null, llmAvailable: null });
  localStorage.clear();
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
  /** Type a link and get as far as the naming question (§3.6-1). */
  async function askOne(user: ReturnType<typeof userEvent.setup>): Promise<void> {
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
    await screen.findByText('怎么命名？');
  }

  // Criterion 24: the two answers reach the daemon as two different requests.
  it('asks how to name a lone video, and sends the answer with the url', async () => {
    const user = userEvent.setup();
    await askOne(user);

    // Nothing is queued while the question is open.
    expect(calls.some((call) => call.url.endsWith('/download/song'))).toBe(false);
    await user.click(screen.getByRole('button', { name: '原标题' }));

    await waitFor(() =>
      expect(calls.find((call) => call.url.endsWith('/download/song'))?.body).toEqual({
        input: 'https://www.bilibili.com/video/BV1?p=2',
        naming_mode: 'original',
      }),
    );
  });

  it('sends the other mode when the other button is used', async () => {
    const user = userEvent.setup();
    await askOne(user);
    await user.click(screen.getByRole('button', { name: '清洗命名' }));

    await waitFor(() =>
      expect(calls.find((call) => call.url.endsWith('/download/song'))?.body).toEqual({
        input: 'https://www.bilibili.com/video/BV1?p=2',
        naming_mode: 'clean',
      }),
    );
  });

  // Paste, Enter, Enter. The remembered answer holds FOCUS, not just the
  // highlight — Radix would otherwise focus 取消, and the second Enter would
  // throw the submission away.
  it('opens with the remembered answer focused, so Enter takes it', async () => {
    const user = userEvent.setup();
    await askOne(user);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: '清洗命名' }));
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(calls.find((call) => call.url.endsWith('/download/song'))?.body).toEqual({
        input: 'https://www.bilibili.com/video/BV1?p=2',
        naming_mode: 'clean',
      }),
    );
  });

  it('moves between the two answers with the arrow keys', async () => {
    const user = userEvent.setup();
    await askOne(user);

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '原标题' }));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '清洗命名' }));

    await user.keyboard('{ArrowLeft}{Enter}');
    await waitFor(() =>
      expect(calls.find((call) => call.url.endsWith('/download/song'))?.body).toEqual({
        input: 'https://www.bilibili.com/video/BV1?p=2',
        naming_mode: 'original',
      }),
    );
  });

  // A remembered answer the machine cannot honour is not a default, and the
  // arrow key must not park focus on a disabled button either.
  it('falls back to the answer that works when there is no LLM', async () => {
    const user = userEvent.setup();
    useMediaTools.setState({ llmAvailable: false });
    await askOne(user);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: '原标题' }));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '原标题' }));
  });

  it('cancelling the question queues nothing', async () => {
    const user = userEvent.setup();
    await askOne(user);
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(calls.some((call) => call.url.endsWith('/download/song'))).toBe(false);
  });

  // Criterion 28, the GUI half. `llm_available: false` is a daemon that knows
  // it has no model — not the `null` of one that has not answered yet.
  it('disables cleaning when the daemon reports no LLM', async () => {
    const user = userEvent.setup();
    useMediaTools.setState({ llmAvailable: false });
    await askOne(user);

    expect(screen.getByRole('button', { name: '清洗命名' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/没有配置 LLM/)).toBeDefined();
  });

  // A keyword has no title to keep, so there is nothing to ask about.
  it('sends a keyword with no naming question at all', async () => {
    const user = userEvent.setup();
    parseResult = () =>
      jsonResponse({ success: true, data: { items: [{ kind: 'keyword', query: '稻香' }] } });
    render(<DownloadBar />);

    await user.type(screen.getByLabelText('下载链接或歌曲名称'), '稻香{Enter}');

    await waitFor(() =>
      expect(calls.find((call) => call.url.endsWith('/download/song'))?.body).toEqual({
        input: '稻香',
      }),
    );
    expect(screen.queryByText('怎么命名？')).toBeNull();
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

    expect(await screen.findByText('下载音频')).toBeDefined();
    expect(screen.getByText('1/3')).toBeDefined();
  });

  // One line, three questions: which song, how far, and is anything behind it.
  it('names the song and counts what is waiting behind it', async () => {
    useDownloads.setState({
      tasks: [
        task({ id: 'run', title: '稻香', state: 'running', stage: 'downloading' }),
        task({ id: 'q1', state: 'queued', stage: null, started_at: null }),
        task({ id: 'q2', state: 'queued', stage: null, started_at: null }),
      ],
    });
    render(<DownloadBar />);

    expect(await screen.findByText('稻香')).toBeDefined();
    expect(screen.getByText('还有 2 个排队')).toBeDefined();
  });

  // The head of the queue is what the line is already showing; counting it as
  // waiting would say "3 waiting" while naming one of the three.
  it('does not count the task it is showing', async () => {
    useDownloads.setState({
      tasks: [
        task({ id: 'q1', state: 'queued', stage: null, started_at: null, created_at: 1 }),
        task({ id: 'q2', state: 'queued', stage: null, started_at: null, created_at: 2 }),
      ],
    });
    render(<DownloadBar />);

    expect(await screen.findByText('还有 1 个排队')).toBeDefined();
  });

  // A queued link has no name yet, and a bilibili URL is long enough to push
  // everything else off a fixed-height row.
  it('caps the width of an unnamed link instead of letting it size the row', () => {
    const url = 'https://www.bilibili.com/video/BV1Ki4y1y7HC?p=2&spm_id_from=333.1007.top_right';
    useDownloads.setState({ tasks: [task({ title: null, input: { type: 'url', url } })] });
    render(<DownloadBar />);

    const label = screen.getByText(url);
    expect(label.className).toContain('truncate');
    expect(label.className).toContain('max-w-56');
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

  it('shares the row with the download status instead of taking turns', async () => {
    useDownloads.setState({ tasks: [task()], batches: [], cancelling: [] });
    render(<DownloadBar />);

    // Greyed out, but present — an action nobody can see is an action nobody
    // knows exists.
    expect(screen.getByText('下载音频')).toBeDefined();
    expect(screen.getByRole('button', { name: '固定' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText(/已选/)).toBeNull();

    useLibrary.setState({ selectedIds: ['song-1', 'song-2'] });

    expect(await screen.findByText('已选 2 首')).toBeDefined();
    expect(screen.getByRole('button', { name: '固定' }).hasAttribute('disabled')).toBe(false);
    // The download line is still right there next to it.
    expect(screen.getByText('下载音频')).toBeDefined();
  });

  it('puts the batch buttons after everything else in the row', () => {
    useLibrary.setState({ selectedIds: ['song-1'] });
    render(<DownloadBar trailing={<button type="button">排序</button>} />);

    // The sort control belongs to the INPUT row; the status row underneath is
    // full width, so the batch group really is at the right edge.
    const row = screen.getByRole('button', { name: '清空选择' }).parentElement;
    expect(row?.textContent).toContain('已选 1 首');
    expect(row?.textContent).not.toContain('排序');
    const buttons = [...(row?.querySelectorAll('button') ?? [])].map(
      (b) => b.getAttribute('aria-label') ?? b.textContent,
    );
    expect(buttons.at(-1)).toBe('清空选择');
  });

  it('keeps "remove from this list" in place but dead where it cannot apply (B-9)', () => {
    useLibrary.setState({ selectedIds: ['song-1'], playlistId: VIRTUAL_ALL_PLAYLIST_ID });
    const { rerender } = render(<DownloadBar />);
    const removeButton = (): HTMLElement => screen.getByRole('button', { name: '从当前列表移除' });

    // A toolbar that changes shape with the view is one you re-read every time.
    expect(removeButton().hasAttribute('disabled')).toBe(true);

    useLibrary.setState({ playlistId: PLAYLIST, search: '' });
    rerender(<DownloadBar />);
    expect(removeButton().hasAttribute('disabled')).toBe(false);

    // A search result spans the library, so it is not a member list.
    useLibrary.setState({ search: '周' });
    rerender(<DownloadBar />);
    expect(removeButton().hasAttribute('disabled')).toBe(true);
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

// M7-18. The row has a fixed height (M4 acceptance: a growing status line
// makes the whole song table jump), so the warning takes the idle slot rather
// than adding a line — and yields it the moment there is real news.
describe('the ffmpeg warning', () => {
  const MISSING = {
    state: 'missing',
    ffmpeg: null,
    ffprobe: null,
    detail: '没有找到：ffmpeg',
  } as const;

  it('says what to install when there is no ffmpeg', async () => {
    render(<DownloadBar />);
    useMediaTools.setState({ info: MISSING });

    await waitFor(() => expect(screen.getByText(/brew install ffmpeg/)).toBeTruthy());
  });

  it('stays quiet when the toolchain is fine', () => {
    render(<DownloadBar />);
    useMediaTools.setState({
      info: {
        state: 'ready',
        ffmpeg: { path: '/opt/homebrew/bin/ffmpeg', source: 'homebrew' },
        ffprobe: { path: '/opt/homebrew/bin/ffprobe', source: 'homebrew' },
        detail: null,
      },
    });

    expect(screen.queryByText(/brew install ffmpeg/)).toBeNull();
  });

  it('gives the slot back to a running download', async () => {
    render(<DownloadBar />);
    useMediaTools.setState({ info: MISSING });
    await waitFor(() => expect(screen.getByText(/brew install ffmpeg/)).toBeTruthy());

    useDownloads.setState({ tasks: [task()] });

    await waitFor(() => expect(screen.queryByText(/brew install ffmpeg/)).toBeNull());
  });
});
