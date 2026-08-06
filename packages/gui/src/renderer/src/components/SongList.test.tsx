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
    selectedIds: [],
    selectionAnchor: null,
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
    // Playable since M5-9: the click downloads the file first.
    expect(screen.getByRole('button', { name: '播放 缺文件' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  // The link three plus pin and redownload (M5-10), in the D8 slot.
  it('greys out copy/open for a song with no link, and offers them with one', async () => {
    useLibrary.setState({
      songs: [
        song({ id: 'song-1', name: '无链接' }),
        song({ id: 'song-2', name: '有链接', source_url: 'https://example.com/x' }),
      ],
    });
    renderList();

    await openContextMenu('song-1');
    expect(screen.getByRole('menuitem', { name: '复制链接' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(screen.getByRole('menuitem', { name: '打开链接' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    // Editing is how a song WITHOUT a link gets one, so it is never disabled.
    expect(
      screen.getByRole('menuitem', { name: '编辑链接…' }).getAttribute('aria-disabled'),
    ).toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    await openContextMenu('song-2');
    expect(
      screen.getByRole('menuitem', { name: '复制链接' }).getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('opens a link through the main process, never the renderer', async () => {
    const openExternal = vi.fn(() => Promise.resolve(true));
    window.larkAPI = { ...window.larkAPI, openExternal };
    useLibrary.setState({
      songs: [song({ id: 'song-1', name: '有链接', source_url: 'https://example.com/x' })],
    });
    renderList();

    await openContextMenu('song-1');
    fireEvent.click(screen.getByRole('menuitem', { name: '打开链接' }));

    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://example.com/x'));
  });

  it('labels the pin action by the current state and posts the flip', async () => {
    useLibrary.setState({ songs: [song({ id: 'song-1', name: '已固定', pinned: true })] });
    renderList();

    await openContextMenu('song-1');
    fireEvent.click(screen.getByRole('menuitem', { name: '取消固定' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/songs/song-1/pin'))).toBe(
        true,
      ),
    );
  });

  it('queues a redownload without guessing whether the daemon will accept it', async () => {
    renderList();
    await openContextMenu('song-1');
    fireEvent.click(screen.getByRole('menuitem', { name: '重新下载' }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url.endsWith('/songs/song-1/redownload')),
      ).toBe(true),
    );
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

describe('drag to reorder (T7 / R24)', () => {
  /** Rows carry this only while dnd-kit's sortable is attached to them. */
  const sortableRows = (): HTMLElement[] =>
    screen
      .getAllByRole('row')
      .filter((row) => row.getAttribute('aria-roledescription') === 'sortable');

  it('is offered on a playlist in its manual order', () => {
    useLibrary.setState({ playlistId: PLAYLIST_ID });
    renderList();

    expect(sortableRows()).toHaveLength(2);
    // The sortable must not cost the table its semantics (spike, plan §8.4).
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 songs
  });

  it.each([
    ['the virtual all list', () => useLibrary.setState({ playlistId: VIRTUAL_ALL_PLAYLIST_ID })],
    ['search results', () => useLibrary.setState({ playlistId: PLAYLIST_ID, search: '第' })],
    [
      'a sorted view',
      () => {
        useLibrary.setState({ playlistId: PLAYLIST_ID });
        useViewPrefs.setState({ sort: { field: 'name', order: 'asc' } });
      },
    ],
    [
      'a single-song list',
      () => useLibrary.setState({ playlistId: PLAYLIST_ID, songs: [SONGS[0]] }),
    ],
  ])('is not offered for %s', (_label, setup) => {
    setup();
    renderList();

    expect(sortableRows()).toEqual([]);
  });
});

describe('row state markers', () => {
  // These four have to stay on four separate channels: a row can be selected,
  // playing, pinned and fileless at once. `text-primary` used to mean playing
  // and was invisible against body text — hence the amber token.
  it('paints the playing row amber', () => {
    render(<SongList onPlay={vi.fn()} currentSongId="song-2" />);

    expect(screen.getByTestId('song-row-song-2').className).toContain('text-state-active');
    expect(screen.getByTestId('song-row-song-1').className).not.toContain('text-state-active');
  });

  it('bolds a pinned song name', () => {
    useLibrary.setState({
      songs: [song({ id: 'song-1', name: '固定的', pinned: true }), SONGS[1]],
    });
    renderList();

    expect(screen.getByText('固定的').className).toContain('font-semibold');
    expect(screen.getByText('第二首').className).not.toContain('font-semibold');
  });

  it('marks the selected row with a left bar, and reserves its width otherwise', () => {
    useLibrary.setState({ selectedIds: ['song-2'] });
    renderList();

    const cellOf = (id: string): Element =>
      screen.getByTestId(`song-row-${id}`).firstElementChild as Element;
    expect(cellOf('song-2').className).toContain('border-l-primary');
    // Always 2px, so selecting never nudges the row sideways.
    expect(cellOf('song-1').className).toContain('border-l-transparent');
    expect(cellOf('song-1').className).toContain('border-l-2');
  });
});
