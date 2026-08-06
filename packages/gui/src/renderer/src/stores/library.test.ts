// Library view fetching (M4-7): what gets requested, and which responses are
// allowed to land on screen.

import type { SongData } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLibrary } from './library.js';
import { useViewPrefs } from './view-prefs.js';

interface Pending {
  url: string;
  /** Complete this request with a successful envelope. */
  succeed: (songs: readonly SongData[]) => void;
  /** Complete it with an error envelope (a RESPONSE, so never retried). */
  fail: (status: number, message: string) => void;
}

function song(id: string, name = id): SongData {
  return {
    id,
    name,
    artist: '',
    source_url: null,
    source_provider: null,
    source_key: null,
    file_origin: 'imported',
    lyrics_offset: 0,
    duration: 0,
    pinned: false,
    created_at: 0,
    updated_at: 0,
  };
}

function envelope(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let pending: Pending[] = [];

/** Requests stay in flight until the test completes them by hand. */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          pending.push({
            url,
            succeed: (songs) => resolve(envelope({ success: true, data: songs }, 200)),
            fail: (status, message) =>
              resolve(envelope({ success: false, error_code: 'FAILED', message }, status)),
          });
        }),
    ),
  );
}

/** Let the store's `.then` chains run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  pending = [];
  stubFetch();
  useLibrary.setState({
    songs: [],
    loading: false,
    error: null,
    playlistId: VIRTUAL_ALL_PLAYLIST_ID,
    search: '',
    selectedIds: [],
    selectionAnchor: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what the view asks for', () => {
  it('reads the virtual all list through the playlist route', () => {
    useLibrary.getState().refresh();
    expect(pending[0]?.url).toBe('http://127.0.0.1:47100/playlists/all/songs');
  });

  it('reads a real playlist through its member list', () => {
    useLibrary.getState().setPlaylistId('a4f1e3c2-0000-4000-8000-000000000001');
    expect(pending[0]?.url).toBe(
      'http://127.0.0.1:47100/playlists/a4f1e3c2-0000-4000-8000-000000000001/songs',
    );
  });

  it('searches the whole library with no limit (D6)', () => {
    useLibrary.getState().setPlaylistId('a4f1e3c2-0000-4000-8000-000000000001');
    pending.length = 0;
    useLibrary.getState().setSearch('周杰伦 & co');

    expect(pending).toHaveLength(1);
    expect(pending[0]?.url).toBe(
      `http://127.0.0.1:47100/songs?search=${encodeURIComponent('周杰伦 & co')}`,
    );
    expect(pending[0]?.url).not.toContain('limit');
  });

  it('ignores a set that changes nothing', () => {
    useLibrary.getState().setSearch('');
    useLibrary.getState().setPlaylistId(VIRTUAL_ALL_PLAYLIST_ID);
    expect(pending).toHaveLength(0);
  });
});

describe('stale responses', () => {
  it('drops an earlier playlist response when the view has moved on', async () => {
    useLibrary.getState().setPlaylistId('a4f1e3c2-0000-4000-8000-000000000001');
    useLibrary.getState().setPlaylistId('a4f1e3c2-0000-4000-8000-000000000002');
    expect(pending).toHaveLength(2);

    // The first playlist answers last — the classic overwrite.
    pending[1]?.succeed([song('second')]);
    await flush();
    pending[0]?.succeed([song('first')]);
    await flush();

    expect(useLibrary.getState().songs.map((s) => s.id)).toEqual(['second']);
    expect(useLibrary.getState().loading).toBe(false);
  });

  it('drops a search response that arrives after the search was cleared', async () => {
    useLibrary.getState().setSearch('lark');
    useLibrary.getState().setSearch('');
    expect(pending).toHaveLength(2);

    pending[1]?.succeed([song('all-songs')]);
    await flush();
    pending[0]?.succeed([song('search-hit')]);
    await flush();

    expect(useLibrary.getState().songs.map((s) => s.id)).toEqual(['all-songs']);
  });

  it('does not surface an error from a request the view no longer wants', async () => {
    useLibrary.getState().setPlaylistId('a4f1e3c2-0000-4000-8000-000000000001');
    useLibrary.getState().setPlaylistId(VIRTUAL_ALL_PLAYLIST_ID);

    pending[0]?.fail(404, 'playlist not found');
    await flush();
    expect(useLibrary.getState().error).toBeNull();

    pending[1]?.succeed([song('a')]);
    await flush();
    expect(useLibrary.getState().songs.map((s) => s.id)).toEqual(['a']);
  });

  it('reports an error the current view did ask for', async () => {
    useLibrary.getState().refresh();
    pending[0]?.fail(500, 'daemon exploded');
    await flush();

    expect(useLibrary.getState().error).toBe('daemon exploded');
    expect(useLibrary.getState().loading).toBe(false);
  });
});

describe('reorder (T7)', () => {
  const PLAYLIST = 'a4f1e3c2-0000-4000-8000-000000000001';
  let sent: { method: string; url: string; body: unknown }[];
  /** Answer for the reorder POST; the refresh GET always succeeds. */
  let reorderStatus: number;

  beforeEach(() => {
    sent = [];
    reorderStatus = 200;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        sent.push({
          method,
          url,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        if (url.includes('/reorder')) {
          return Promise.resolve(
            envelope(
              reorderStatus === 200
                ? { success: true, data: { playlist_id: PLAYLIST } }
                : { success: false, error_code: 'INVALID_REORDER', message: '锚点不相邻' },
              reorderStatus,
            ),
          );
        }
        // The refresh answers with the daemon's truth: the order never moved.
        return Promise.resolve(
          envelope({ success: true, data: [song('a'), song('b'), song('c')] }, 200),
        );
      }),
    );
    useLibrary.setState({
      playlistId: PLAYLIST,
      search: '',
      songs: [song('a'), song('b'), song('c')],
    });
  });

  const order = (): string[] => useLibrary.getState().songs.map((s) => s.id);

  it('moves the row before the daemon answers, and anchors on the new neighbours', async () => {
    const done = useLibrary.getState().reorderSong('a', 'c');

    // Optimistic: the list is already in its new order while the POST is out.
    expect(order()).toEqual(['b', 'c', 'a']);
    await done;

    const posts = sent.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(`http://127.0.0.1:47100/playlists/${PLAYLIST}/reorder`);
    expect(posts[0]?.body).toEqual({ song_id: 'a', after_song_id: 'c' });
    expect(order()).toEqual(['b', 'c', 'a']);
  });

  it('puts the old order back and refetches when the daemon refuses', async () => {
    reorderStatus = 400;

    await expect(useLibrary.getState().reorderSong('c', 'a')).rejects.toThrow();

    expect(order()).toEqual(['a', 'b', 'c']);
    expect(sent.some((call) => call.method === 'GET' && call.url.endsWith('/songs'))).toBe(true);
  });

  it('sends nothing for a drop that changes nothing', async () => {
    await useLibrary.getState().reorderSong('a', 'a');
    await useLibrary.getState().reorderSong('a', 'nope');

    expect(sent).toEqual([]);
    expect(order()).toEqual(['a', 'b', 'c']);
  });
});

describe('selection (S1)', () => {
  const view = ['a', 'b', 'c', 'd'];
  const select = () => useLibrary.getState();

  beforeEach(() => {
    useLibrary.setState({ songs: view.map((id) => song(id)), playlistId: 'p1', search: '' });
  });

  it('a plain pick replaces the selection and moves the anchor', () => {
    select().selectOnly('b');
    expect(useLibrary.getState().selectedIds).toEqual(['b']);
    select().selectOnly('c');
    expect(useLibrary.getState().selectedIds).toEqual(['c']);
    expect(useLibrary.getState().selectionAnchor).toBe('c');
  });

  it('a range measures from the anchor, and re-ranging narrows instead of ratcheting', () => {
    select().selectOnly('b');
    select().selectRange('d', view);
    expect(useLibrary.getState().selectedIds).toEqual(['b', 'c', 'd']);

    // Same anchor, closer target: the range shrinks.
    select().selectRange('c', view);
    expect(useLibrary.getState().selectedIds).toEqual(['b', 'c']);
  });

  it('keeps click order across toggles — it is what "add to playlist" appends in', () => {
    select().selectOnly('c');
    select().toggleSelected('a');
    select().toggleSelected('d');
    expect(useLibrary.getState().selectedIds).toEqual(['c', 'a', 'd']);
    select().toggleSelected('a');
    expect(useLibrary.getState().selectedIds).toEqual(['c', 'd']);
  });

  it('drops only the rows a refresh deleted, keeping the rest', async () => {
    select().selectOnly('a');
    select().toggleSelected('c');

    select().refresh();
    pending.at(-1)?.succeed([song('a'), song('b')]); // 'c' is gone
    await flush();

    expect(useLibrary.getState().selectedIds).toEqual(['a']);
  });

  it('clears on a view change, where the anchor would be meaningless', () => {
    select().selectOnly('a');
    select().setPlaylistId('p2');
    expect(useLibrary.getState().selectedIds).toEqual([]);
    expect(useLibrary.getState().selectionAnchor).toBeNull();

    useLibrary.setState({ selectedIds: ['a'], selectionAnchor: 'a' });
    select().setSearch('周');
    expect(useLibrary.getState().selectedIds).toEqual([]);
  });

  it('clears when the view is re-ordered, where a Shift anchor would misfire', () => {
    select().selectOnly('a');
    useViewPrefs.getState().setSort({ field: 'name', order: 'asc' });
    expect(useLibrary.getState().selectedIds).toEqual([]);
  });

  it('selects exactly what is on screen, not the whole library', () => {
    select().selectVisible(['b', 'c']);
    expect(useLibrary.getState().selectedIds).toEqual(['b', 'c']);
    select().clearSelection();
    expect(useLibrary.getState().selectedIds).toEqual([]);
  });
});
