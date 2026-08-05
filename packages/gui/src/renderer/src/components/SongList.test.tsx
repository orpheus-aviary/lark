// Library table behaviour: the §4.1 context-menu matrix, the no-file marker,
// inline editing and the delete confirmation (D7/D9/D16).

import type { PlaylistData, SongData } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLibrary } from '../stores/library.js';
import { usePlaylists } from '../stores/playlists.js';
import { useViewPrefs } from '../stores/view-prefs.js';
import { SongList } from './SongList.js';

const PLAYLIST_ID = 'a4f1e3c2-0000-4000-8000-000000000001';

function song(partial: Partial<SongData> & { id: string; name: string }): SongData {
  return {
    artist: '歌手',
    source_url: null,
    source_provider: null,
    source_key: null,
    file_origin: 'imported',
    lyrics_offset: 0,
    duration: 0,
    pinned: false,
    created_at: 0,
    updated_at: 0,
    has_file: true,
    ...partial,
  };
}

function playlist(id: string, name: string): PlaylistData {
  return { id, name, created_at: 0, updated_at: 0, song_count: 0 };
}

const SONGS = [song({ id: 'song-1', name: '第一首' }), song({ id: 'song-2', name: '第二首' })];

let calls: { method: string; url: string }[] = [];

function stubFetch(): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url });
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
}

function renderList(onPlay = vi.fn()): { onPlay: ReturnType<typeof vi.fn> } {
  render(<SongList onPlay={onPlay} currentSongId={null} />);
  return { onPlay };
}

/** Open the row's context menu and wait for the portal content. */
async function openContextMenu(songId: string): Promise<void> {
  fireEvent.contextMenu(screen.getByTestId(`song-row-${songId}`));
  await screen.findByRole('menu');
}

beforeEach(() => {
  stubFetch();
  window.localStorage.clear();
  useViewPrefs.setState({
    columns: { duration: false, fileSize: false, createdAt: false },
    widths: {},
    sort: { field: 'default', order: 'asc' },
  });
  useLibrary.setState({
    songs: SONGS,
    loading: false,
    error: null,
    playlistId: VIRTUAL_ALL_PLAYLIST_ID,
    search: '',
    selectedSongId: null,
  });
  usePlaylists.setState({ playlists: [playlist(VIRTUAL_ALL_PLAYLIST_ID, 'all')] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rows', () => {
  it('numbers rows and marks a song with no file', () => {
    useLibrary.setState({
      songs: [
        song({ id: 'song-1', name: '第一首' }),
        song({ id: 'gone', name: '缺文件', has_file: false }),
      ],
    });
    renderList();

    expect(screen.getByText('第一首')).toBeDefined();
    expect(screen.getByText('[需要下载]')).toBeDefined();
    expect(screen.getByRole('button', { name: '播放 缺文件' }).hasAttribute('disabled')).toBe(true);
  });

  it('plays on double click', async () => {
    const { onPlay } = renderList();
    fireEvent.doubleClick(screen.getByTestId('song-row-song-1'));
    await waitFor(() =>
      expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ id: 'song-1' })),
    );
  });

  it('shows the empty state instead of rows', () => {
    useLibrary.setState({ songs: [] });
    renderList();
    expect(screen.getByText('暂无歌曲')).toBeDefined();
  });

  it('says so when the search found nothing', () => {
    useLibrary.setState({ songs: [], search: '找不到' });
    renderList();
    expect(screen.getByText('没有匹配的歌曲')).toBeDefined();
  });
});

describe('context menu matrix (§4.1)', () => {
  it('hides "remove from this list" on the virtual all view', async () => {
    renderList();
    await openContextMenu('song-1');

    expect(screen.getByRole('menuitem', { name: '播放' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: '从当前列表移除' })).toBeNull();
  });

  it('hides it in search results even when a real playlist is selected', async () => {
    useLibrary.setState({ playlistId: PLAYLIST_ID, search: '第' });
    usePlaylists.setState({
      playlists: [playlist(VIRTUAL_ALL_PLAYLIST_ID, 'all'), playlist(PLAYLIST_ID, '我的歌单')],
    });
    renderList();
    await openContextMenu('song-1');

    expect(screen.queryByRole('menuitem', { name: '从当前列表移除' })).toBeNull();
  });

  it('shows it on a real playlist and removes through the membership route', async () => {
    useLibrary.setState({ playlistId: PLAYLIST_ID });
    usePlaylists.setState({
      playlists: [playlist(VIRTUAL_ALL_PLAYLIST_ID, 'all'), playlist(PLAYLIST_ID, '我的歌单')],
    });
    renderList();
    await openContextMenu('song-1');

    fireEvent.click(screen.getByRole('menuitem', { name: '从当前列表移除' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'DELETE',
        url: `http://127.0.0.1:47100/playlists/${PLAYLIST_ID}/songs/song-1`,
      }),
    );
  });

  it('hides "add to playlist" when no user playlist exists', async () => {
    renderList();
    await openContextMenu('song-1');
    expect(screen.queryByRole('menuitem', { name: /添加到歌单/ })).toBeNull();
  });

  it('offers add targets once a user playlist exists', async () => {
    usePlaylists.setState({
      playlists: [playlist(VIRTUAL_ALL_PLAYLIST_ID, 'all'), playlist(PLAYLIST_ID, '我的歌单')],
    });
    renderList();
    // The row action and the menu entry appear together; the row button is
    // checked before opening the menu, which aria-hides the rest of the page.
    expect(screen.getByRole('button', { name: '添加 第一首 到歌单' })).toBeDefined();

    await openContextMenu('song-1');
    expect(screen.getByRole('menuitem', { name: /添加到歌单/ })).toBeDefined();
  });
});

describe('inline edit (D7)', () => {
  it('writes a changed name through PUT /songs/:id', async () => {
    const user = userEvent.setup();
    renderList();

    await user.dblClick(screen.getByRole('button', { name: '第一首' }));
    const input = screen.getByDisplayValue('第一首');
    await user.clear(input);
    await user.type(input, '新名字{Enter}');

    await waitFor(() =>
      expect(calls).toContainEqual({ method: 'PUT', url: 'http://127.0.0.1:47100/songs/song-1' }),
    );
  });

  it('discards an emptied song name', async () => {
    const user = userEvent.setup();
    renderList();

    await user.dblClick(screen.getByRole('button', { name: '第一首' }));
    const input = screen.getByDisplayValue('第一首');
    await user.clear(input);
    await user.type(input, '{Enter}');

    await waitFor(() => expect(screen.getByText('第一首')).toBeDefined());
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('cancels on Escape', async () => {
    const user = userEvent.setup();
    renderList();

    await user.dblClick(screen.getByRole('button', { name: '第一首' }));
    await user.type(screen.getByDisplayValue('第一首'), '改动{Escape}');

    await waitFor(() => expect(screen.getByText('第一首')).toBeDefined());
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('delete confirmation (D9)', () => {
  it('deletes only after the dialog is confirmed', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('button', { name: '删除 第一首' }));
    expect(await screen.findByRole('dialog')).toBeDefined();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    await user.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'DELETE',
        url: 'http://127.0.0.1:47100/songs/song-1',
      }),
    );
  });

  it('deletes nothing when the dialog is cancelled', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('button', { name: '删除 第一首' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});
