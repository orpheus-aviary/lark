// Playlist picker + column toggles + search (D10/D3/D6).

import type { PlaylistData } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLibrary } from '../stores/library.js';
import { usePlaylists } from '../stores/playlists.js';
import { useViewPrefs } from '../stores/view-prefs.js';
import { TopBar } from './TopBar.js';

const PLAYLIST_ID = 'a4f1e3c2-0000-4000-8000-000000000001';

function playlist(id: string, name: string, songCount = 0): PlaylistData {
  return { id, name, created_at: 0, updated_at: 0, song_count: songCount };
}

let calls: { method: string; url: string; body: unknown }[] = [];

function stubFetch(): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
}

async function openPicker(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: '选择歌单' }));
  await screen.findByRole('button', { name: /新建歌单/ });
}

beforeEach(() => {
  stubFetch();
  window.localStorage.clear();
  useViewPrefs.setState({
    columns: { duration: false, fileSize: false, createdAt: false },
    widths: {},
    sort: { field: 'default', order: 'asc' },
  });
  useLibrary.setState({ playlistId: VIRTUAL_ALL_PLAYLIST_ID, search: '', songs: [] });
  usePlaylists.setState({
    playlists: [playlist(VIRTUAL_ALL_PLAYLIST_ID, 'all', 20), playlist(PLAYLIST_ID, '我的歌单', 3)],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('playlist picker', () => {
  it('lists playlists with their counts and switches the view', async () => {
    const user = userEvent.setup();
    render(<TopBar />);
    await openPicker(user);

    expect(screen.getByText('我的歌单')).toBeDefined();
    expect(screen.getByText('(3)')).toBeDefined();

    await user.click(screen.getByText('我的歌单'));
    expect(useLibrary.getState().playlistId).toBe(PLAYLIST_ID);
  });

  it('offers no rename or delete for the virtual all playlist', async () => {
    const user = userEvent.setup();
    render(<TopBar />);
    await openPicker(user);

    expect(screen.queryByRole('button', { name: '重命名 all' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除 all' })).toBeNull();
    expect(screen.getByRole('button', { name: '重命名 我的歌单' })).toBeDefined();
  });

  it('creates a playlist from the inline input', async () => {
    const user = userEvent.setup();
    render(<TopBar />);
    await openPicker(user);

    await user.click(screen.getByRole('button', { name: /新建歌单/ }));
    await user.type(screen.getByPlaceholderText('新歌单名称…'), '新单{Enter}');

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        url: 'http://127.0.0.1:47100/playlists',
        body: { name: '新单' },
      }),
    );
  });

  it('renames in place', async () => {
    const user = userEvent.setup();
    render(<TopBar />);
    await openPicker(user);

    await user.click(screen.getByRole('button', { name: '重命名 我的歌单' }));
    const input = screen.getByDisplayValue('我的歌单');
    await user.clear(input);
    await user.type(input, '改名了{Enter}');

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        url: `http://127.0.0.1:47100/playlists/${PLAYLIST_ID}`,
        body: { name: '改名了' },
      }),
    );
  });

  it('drops an emptied rename instead of writing it', async () => {
    const user = userEvent.setup();
    render(<TopBar />);
    await openPicker(user);

    await user.click(screen.getByRole('button', { name: '重命名 我的歌单' }));
    await user.clear(screen.getByDisplayValue('我的歌单'));
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.queryByDisplayValue('我的歌单')).toBeNull());
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('deletes only after confirmation (D9)', async () => {
    const user = userEvent.setup();
    render(<TopBar />);
    await openPicker(user);

    await user.click(screen.getByRole('button', { name: '删除 我的歌单' }));
    expect(await screen.findByRole('dialog')).toBeDefined();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    await user.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'DELETE',
        url: `http://127.0.0.1:47100/playlists/${PLAYLIST_ID}`,
        body: undefined,
      }),
    );
  });
});

describe('column toggles', () => {
  it('persists a toggle to the view preferences', async () => {
    const user = userEvent.setup();
    render(<TopBar />);

    await user.click(screen.getByLabelText('时长'));
    expect(useViewPrefs.getState().columns.duration).toBe(true);
    expect(window.localStorage.getItem('lark.gui.library.columns')).toContain('"duration":true');
  });
});

describe('search', () => {
  it('commits one debounced query to the store', async () => {
    const user = userEvent.setup();
    render(<TopBar />);

    await user.type(screen.getByRole('searchbox', { name: '搜索歌曲或歌手' }), '周杰伦');

    await waitFor(() => expect(useLibrary.getState().search).toBe('周杰伦'));
    const searches = calls.filter((c) => c.url.includes('/songs?search='));
    expect(searches).toHaveLength(1);
  });

  it('clears back to the playlist view', async () => {
    const user = userEvent.setup();
    render(<TopBar />);

    await user.type(screen.getByRole('searchbox', { name: '搜索歌曲或歌手' }), '周');
    await waitFor(() => expect(useLibrary.getState().search).toBe('周'));

    await user.click(screen.getByRole('button', { name: '清除搜索' }));
    await waitFor(() => expect(useLibrary.getState().search).toBe(''));
  });
});

describe('export', () => {
  const EXPORTED = {
    format: 'lark-playlist',
    version: 1,
    exported_at: 1789000000000,
    playlist: { name: 'all' },
    songs: [{ name: '歌' }],
  };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? 'GET',
          url,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        const data = url.includes('/export') ? EXPORTED : [];
        return Promise.resolve(
          new Response(JSON.stringify({ success: true, data }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }),
    );
  });

  it('hands the whole library to the save dialog, indented', async () => {
    const saveExportFile = vi.fn((_input: { default_name: string; content: string }) =>
      Promise.resolve(true),
    );
    window.larkAPI = { ...window.larkAPI, saveExportFile };
    const user = userEvent.setup();
    render(<TopBar />);
    await openPicker(user);

    await user.click(screen.getByRole('button', { name: '导出 all' }));

    await waitFor(() => expect(saveExportFile).toHaveBeenCalledTimes(1));
    expect(calls.some((c) => c.url.endsWith('/playlists/all/export'))).toBe(true);
    expect(saveExportFile.mock.calls[0][0]).toEqual({
      default_name: 'all.lark-playlist.json',
      content: JSON.stringify(EXPORTED, null, 2),
    });
  });

  it('offers export for a user playlist too', async () => {
    const user = userEvent.setup();
    render(<TopBar />);
    await openPicker(user);

    await user.click(screen.getByRole('button', { name: '导出 我的歌单' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith(`/playlists/${PLAYLIST_ID}/export`))).toBe(true),
    );
  });
});
