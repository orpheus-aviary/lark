// Editing a link (M5-11): the preview that writes nothing, the conflict the
// daemon reports by id, and the refetch offer when the key really moved.

import type { SongData } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLibrary } from '../stores/library.js';
import { EditLinkDialog } from './EditLinkDialog.js';

const VIDEO_URL = 'https://www.bilibili.com/video/BV1Ki4y1y7HC';

function song(overrides: Partial<SongData> = {}): SongData {
  return {
    id: 'song-1',
    name: '稻香',
    artist: '周杰伦',
    source_url: VIDEO_URL,
    source_provider: 'bilibili',
    source_key: 'BV1Ki4y1y7HC:1',
    file_origin: 'downloaded',
    lyrics_offset: 0,
    duration: 100,
    pinned: false,
    created_at: 0,
    updated_at: 0,
    has_file: true,
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let calls: Call[] = [];
/** What `PUT /songs/:id` answers with, when a test wants a failure. */
let putResponse: (() => Response) | null = null;
/** What a later `GET /songs/:id` reports — how a key change is detected. */
let songAfterSave: SongData = song();
/** What the library answers with after a view switch. */
let libraryAnswer: SongData[] = [song()];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  putResponse = null;
  songAfterSave = song();
  libraryAnswer = [song()];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (url.includes('/recognize-url')) {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              source_url: `${VIDEO_URL}?p=2`,
              source_provider: 'bilibili',
              source_key: 'BV1Ki4y1y7HC:222',
              video_title: '第二个分P',
            },
          }),
        );
      }
      if (method === 'PUT' && url.includes('/songs/')) {
        return Promise.resolve(
          putResponse === null ? jsonResponse({ success: true }) : putResponse(),
        );
      }
      if (url.includes('/playlists/') && url.endsWith('/songs')) {
        return Promise.resolve(jsonResponse({ success: true, data: libraryAnswer }));
      }
      if (method === 'GET' && /\/songs\/[\w-]+$/.test(url)) {
        return Promise.resolve(jsonResponse({ success: true, data: songAfterSave }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: [] }));
    }),
  );
  useLibrary.setState({
    songs: [song()],
    loading: false,
    error: null,
    playlistId: VIRTUAL_ALL_PLAYLIST_ID,
    search: '',
    selectedSongId: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function open(target: SongData = song()): {
  user: ReturnType<typeof userEvent.setup>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<EditLinkDialog song={target} onClose={onClose} />);
  return { user, onClose };
}

const putBodies = (): unknown[] => calls.filter((c) => c.method === 'PUT').map((c) => c.body);

describe('EditLinkDialog', () => {
  it("starts from the song's current link", () => {
    open();
    expect((screen.getByLabelText('来源链接') as HTMLInputElement).value).toBe(VIDEO_URL);
  });

  it('fills the field from a preview without writing anything (R6)', async () => {
    const { user } = open();

    await user.click(screen.getByRole('button', { name: '自动识别' }));

    await waitFor(() =>
      expect((screen.getByLabelText('来源链接') as HTMLInputElement).value).toBe(
        `${VIDEO_URL}?p=2`,
      ),
    );
    expect(putBodies()).toEqual([]); // the preview is not a save
  });

  it('clears the source when the field is emptied', async () => {
    const { user, onClose } = open();

    await user.clear(screen.getByLabelText('来源链接'));
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(putBodies()).toEqual([{ source_url: null }]));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('offers a refetch when the key moved under a song that has a file', async () => {
    songAfterSave = song({ source_key: 'BV1Ki4y1y7HC:999' });
    const { user } = open();

    await user.clear(screen.getByLabelText('来源链接'));
    await user.type(screen.getByLabelText('来源链接'), `${VIDEO_URL}?p=2`);
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('链接已换')).toBeDefined();
    await user.click(screen.getByRole('button', { name: '重新下载' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/redownload'))).toBe(true),
    );
  });

  it('does not offer a refetch when the key is unchanged', async () => {
    const { user, onClose } = open();

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByText('链接已换')).toBeNull();
  });

  // The daemon reports the owner by id in `details`; the name is looked up
  // locally when possible (M5-11 / M5-20).
  it('names the song that already owns the link and offers to locate it', async () => {
    libraryAnswer = [song(), song({ id: 'other', name: '别的歌' })];
    useLibrary.setState({ songs: libraryAnswer });
    putResponse = () =>
      jsonResponse(
        {
          success: false,
          error_code: 'SOURCE_KEY_CONFLICT',
          message: 'that link belongs to another song',
          details: { conflicting_song_id: 'other' },
        },
        409,
      );
    const { user, onClose } = open();

    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/该链接已属于《别的歌》/)).toBeDefined();
    expect(onClose).not.toHaveBeenCalled(); // the dialog stays put

    // Locating switches to the whole library and selects the row.
    useLibrary.setState({ playlistId: 'some-playlist', search: '第一' });
    await user.click(screen.getByRole('button', { name: '定位' }));

    await waitFor(() => {
      const state = useLibrary.getState();
      expect(state.playlistId).toBe(VIRTUAL_ALL_PLAYLIST_ID);
      expect(state.search).toBe('');
      expect(state.selectedSongId).toBe('other');
    });
  });
});
