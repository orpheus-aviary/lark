// Playback operations, the ended/mode semantics carried over from the Go
// version (D11/D12), and §4.4 reconciliation.

import type { PlayerStatusData, SongData } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { UI_PLAY_MODE_CYCLE } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaElement } from '../player/media.js';
import { useLibrary } from './library.js';
import { usePlayer } from './player.js';
import { useViewPrefs } from './view-prefs.js';

interface FakeMedia extends MediaElement {
  duration: number;
}

function fakeMedia(overrides: Partial<MediaElement> = {}): FakeMedia {
  return {
    src: '',
    currentTime: 0,
    duration: 0,
    load: vi.fn(),
    pause: vi.fn(),
    removeAttribute: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...overrides,
  };
}

function song(id: string, overrides: Partial<SongData> = {}): SongData {
  return {
    id,
    name: id,
    artist: '歌手',
    source_url: null,
    source_provider: null,
    source_key: null,
    file_origin: 'imported',
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
let songLookup: (id: string) => { status: number; song?: SongData } = () => ({ status: 404 });

function jsonResponse(body: unknown, status: number): Response {
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
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      // No lyrics in these fixtures: 404 is the normal "not fetched yet".
      if (url.includes('/lyrics/')) return Promise.resolve(new Response('', { status: 404 }));

      if (url.includes('/ensure-file')) {
        return Promise.resolve(jsonResponse({ success: true, data: { task_id: 'ensure-1' } }, 200));
      }

      const match = /\/songs\/([\w-]+)$/.exec(url);
      if (match && method === 'GET') {
        const lookup = songLookup(match[1] as string);
        return Promise.resolve(
          lookup.status === 404
            ? jsonResponse({ success: false, error_code: 'SONG_NOT_FOUND' }, 404)
            : jsonResponse({ success: true, data: lookup.song }, 200),
        );
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }, 200));
    }),
  );
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function reports(): PlayerStatusData[] {
  return calls
    .filter((call) => call.url.endsWith('/player/report'))
    .map((call) => call.body as PlayerStatusData);
}

let audio: FakeMedia;

beforeEach(() => {
  stubFetch();
  window.localStorage.clear();
  audio = fakeMedia();
  useViewPrefs.setState({
    columns: { duration: false, fileSize: false, createdAt: false },
    widths: {},
    sort: { field: 'default', order: 'asc' },
  });
  useLibrary.setState({
    songs: [song('a'), song('b'), song('c')],
    playlistId: VIRTUAL_ALL_PLAYLIST_ID,
    search: '',
    loading: false,
    error: null,
  });
  usePlayer.setState({
    currentSong: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    playMode: 'sequential',
    lyrics: [],
    mediaError: false,
    recovering: false,
    intentPlaying: false,
  });
  usePlayer.getState().attachAudio(audio);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('play', () => {
  it('points the element at the media proxy and reports', async () => {
    const result = await usePlayer.getState().play(song('a'));
    await flush();

    expect(result).toEqual({ ok: true });
    expect(audio.src).toBe('lark-media://song/a');
    expect(audio.play).toHaveBeenCalled();
    expect(usePlayer.getState().currentSong?.id).toBe('a');
    expect(usePlayer.getState().intentPlaying).toBe(true);
    expect(reports().at(-1)?.current_song?.id).toBe('a');
  });

  // D16 flipped in M5-9: a missing file is fetched and played, not refused.
  it('queues a download for a song with no file instead of refusing', async () => {
    const result = await usePlayer.getState().play(song('gone', { has_file: false }));

    expect(result).toEqual({ ok: true, message: '正在下载，完成后自动播放' });
    expect(audio.src).toBe(''); // nothing plays yet
    expect(
      calls.some((c) => c.method === 'POST' && c.url.endsWith('/songs/gone/ensure-file')),
    ).toBe(true);
  });

  // N4g-3 flipped this one. It used to assert that next/prev REFUSED a
  // fileless song, and the reason given was "no download cascade" — which is
  // now the other half of the same rule: a finger fetches, a song running out
  // skips. The cascade is what the case below guards.
  it('fetches a fileless song reached by next, like a click on the row', async () => {
    useLibrary.setState({ songs: [song('a'), song('gone', { has_file: false })] });
    await usePlayer.getState().play(song('a'));
    calls.length = 0;

    const result = await usePlayer.getState().next();

    expect(result).toEqual({ ok: true, message: '正在下载，完成后自动播放' });
    expect(
      calls.some((c) => c.method === 'POST' && c.url.endsWith('/songs/gone/ensure-file')),
    ).toBe(true);
  });

  it('reports a rejected play() rather than pretending to play', async () => {
    audio = fakeMedia({ play: vi.fn(() => Promise.reject(new Error('NotAllowedError'))) });
    usePlayer.getState().attachAudio(audio);

    const result = await usePlayer.getState().play(song('a'));
    expect(result).toEqual({ ok: false, message: 'NotAllowedError' });
    expect(usePlayer.getState().isPlaying).toBe(false);
  });
});

describe('seek', () => {
  it('clamps past the end instead of refusing (§4.3)', async () => {
    await usePlayer.getState().play(song('a'));
    usePlayer.setState({ duration: 100 });

    await expect(usePlayer.getState().seek(500)).resolves.toEqual({ ok: true });
    expect(audio.currentTime).toBe(100);

    await usePlayer.getState().seek(-10);
    expect(audio.currentTime).toBe(0);
  });
});

describe('next / prev', () => {
  it('follows the visible list', async () => {
    await usePlayer.getState().play(song('a'));
    await usePlayer.getState().next();
    expect(usePlayer.getState().currentSong?.id).toBe('b');

    await usePlayer.getState().prev();
    expect(usePlayer.getState().currentSong?.id).toBe('a');
  });

  it('goes quiet when the playing song is not in the current list (D11)', async () => {
    await usePlayer.getState().play(song('a'));
    useLibrary.setState({ songs: [song('x'), song('y')] });

    await expect(usePlayer.getState().next()).resolves.toEqual({
      ok: false,
      message: '当前歌曲不在这个列表里',
    });
    expect(usePlayer.getState().currentSong?.id).toBe('a');
  });
});

describe('ended', () => {
  it('stops at the end of the list in sequential mode', async () => {
    await usePlayer.getState().play(song('c'));
    usePlayer.setState({ isPlaying: true });

    usePlayer.getState().handleEnded();
    await flush();

    expect(usePlayer.getState().currentSong?.id).toBe('c');
    expect(usePlayer.getState().isPlaying).toBe(false);
    expect(usePlayer.getState().intentPlaying).toBe(false);
  });

  it('wraps in repeat-all', async () => {
    await usePlayer.getState().setMode('repeat-all');
    await usePlayer.getState().play(song('c'));

    usePlayer.getState().handleEnded();
    await flush();

    expect(usePlayer.getState().currentSong?.id).toBe('a');
  });

  it('restarts the same song in repeat-one', async () => {
    await usePlayer.getState().setMode('repeat-one');
    await usePlayer.getState().play(song('b'));
    audio.currentTime = 90;

    usePlayer.getState().handleEnded();
    await flush();

    expect(usePlayer.getState().currentSong?.id).toBe('b');
    expect(audio.currentTime).toBe(0);
  });

  it('skips a fileless neighbour instead of stopping, and downloads nothing', async () => {
    // The no-cascade rule, in the only place it still applies: nobody is
    // watching a song run out, so nothing here may spend data (N4g-3).
    useLibrary.setState({
      songs: [song('a'), song('gone', { has_file: false }), song('c')],
    });
    await usePlayer.getState().play(song('a'));
    calls.length = 0;

    usePlayer.getState().handleEnded();
    await flush();

    expect(usePlayer.getState().currentSong?.id).toBe('c');
    expect(calls.some((c) => c.url.includes('/ensure-file'))).toBe(false);
  });

  it('is ignored while the generation recovery owns the element (M4-8)', async () => {
    await usePlayer.getState().play(song('a'));
    usePlayer.setState({ recovering: true });

    usePlayer.getState().handleEnded();
    await flush();

    expect(usePlayer.getState().currentSong?.id).toBe('a');
  });
});

describe('play mode', () => {
  it('cycles in the Go order and persists the choice (D12)', async () => {
    const seen: string[] = [];
    for (let i = 0; i < UI_PLAY_MODE_CYCLE.length; i++) {
      seen.push(usePlayer.getState().playMode);
      await usePlayer.getState().cycleMode();
    }
    expect(seen).toEqual(['sequential', 'repeat-all', 'repeat-one', 'shuffle']);
    expect(usePlayer.getState().playMode).toBe('sequential');
    expect(window.localStorage.getItem('lark.gui.player.mode')).toContain('sequential');
  });
});

describe('media errors', () => {
  it('stops the player but keeps the intent for recovery (M4-6/M4-8)', async () => {
    await usePlayer.getState().play(song('a'));
    usePlayer.setState({ isPlaying: true });

    usePlayer.getState().handleMediaError();
    await flush();

    expect(usePlayer.getState().mediaError).toBe(true);
    expect(usePlayer.getState().isPlaying).toBe(false);
    expect(usePlayer.getState().intentPlaying).toBe(true);
  });

  it('ignores the error that teardown itself produces', () => {
    usePlayer.getState().handleMediaError();
    expect(usePlayer.getState().mediaError).toBe(false);
  });
});

describe('§4.4 reconciliation', () => {
  it('stops and reports null when the playing song was deleted', async () => {
    await usePlayer.getState().play(song('a'));
    usePlayer.setState({ isPlaying: true });
    songLookup = () => ({ status: 404 });

    await usePlayer.getState().reconcileCurrentSong();
    await flush();

    expect(usePlayer.getState().currentSong).toBeNull();
    expect(usePlayer.getState().isPlaying).toBe(false);
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.removeAttribute).toHaveBeenCalledWith('src');
    expect(reports().at(-1)?.current_song).toBeNull();
  });

  it('adopts new metadata without interrupting playback', async () => {
    await usePlayer.getState().play(song('a'));
    songLookup = (id) => ({ status: 200, song: song(id, { name: '改过的名字' }) });

    await usePlayer.getState().reconcileCurrentSong();
    await flush();

    expect(usePlayer.getState().currentSong?.name).toBe('改过的名字');
    expect(audio.pause).not.toHaveBeenCalled();
    expect(reports().at(-1)?.current_song?.name).toBe('改过的名字');
  });
});
