// The §4.3 command matrix as the daemon sees it: what the GUI does, and what
// it acks back.

import type { AckRequest, PlayerCommand, PlayerCommandEvent, SongData } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLibrary } from '../stores/library.js';
import { usePlayer } from '../stores/player.js';
import { useViewPrefs } from '../stores/view-prefs.js';
import type { MediaElement } from './media.js';
import { COMMAND_DEADLINE_MS, handlePlayerCommand } from './remote.js';

const PLAYLIST_ID = 'a4f1e3c2-0000-4000-8000-000000000001';

function fakeMedia(overrides: Partial<MediaElement> = {}): MediaElement {
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
    artist: '',
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
/** Members returned for `GET /playlists/:id/songs`; null answers 404. */
let playlistMembers: readonly SongData[] | null = [];
let libraryLookup: readonly SongData[] = [];

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
      if (url.includes('/lyrics/')) return Promise.resolve(new Response('', { status: 404 }));

      if (url.includes('/playlists/') && url.endsWith('/songs')) {
        return Promise.resolve(
          playlistMembers === null
            ? jsonResponse({ success: false, error_code: 'PLAYLIST_NOT_FOUND' }, 404)
            : jsonResponse({ success: true, data: playlistMembers }, 200),
        );
      }

      if (url.includes('/ensure-file')) {
        return Promise.resolve(jsonResponse({ success: true, data: { task_id: 'ensure-1' } }, 200));
      }

      const match = /\/songs\/([\w-]+)$/.exec(url);
      if (match && method === 'GET') {
        const found = libraryLookup.find((s) => s.id === match[1]);
        return Promise.resolve(
          found
            ? jsonResponse({ success: true, data: found }, 200)
            : jsonResponse({ success: false, error_code: 'SONG_NOT_FOUND' }, 404),
        );
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }, 200));
    }),
  );
}

function acks(): AckRequest[] {
  return calls
    .filter((call) => call.url.endsWith('/player/ack'))
    .map((call) => call.body as AckRequest);
}

const waitForAck = (count = 1): Promise<void> =>
  vi.waitFor(() => {
    expect(acks()).toHaveLength(count);
  });

let commandCount = 0;
function event(payload: PlayerCommand): PlayerCommandEvent {
  commandCount++;
  return { type: 'player:command', request_id: `req-${commandCount}`, ...payload };
}

beforeEach(() => {
  stubFetch();
  window.localStorage.clear();
  playlistMembers = [];
  libraryLookup = [];
  useViewPrefs.setState({
    columns: { duration: false, fileSize: false, createdAt: false },
    widths: {},
    sort: { field: 'default', order: 'asc' },
  });
  useLibrary.setState({
    songs: [song('a'), song('b')],
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
  usePlayer.getState().attachAudio(fakeMedia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('play', () => {
  it('plays a song from the current view', async () => {
    handlePlayerCommand(event({ command: 'play', song_id: 'b' }), Date.now());
    await waitForAck();

    expect(usePlayer.getState().currentSong?.id).toBe('b');
    expect(acks()[0]?.ok).toBe(true);
  });

  it('falls back to the library for a song outside the view', async () => {
    libraryLookup = [song('far')];
    handlePlayerCommand(event({ command: 'play', song_id: 'far' }), Date.now());
    await waitForAck();

    expect(usePlayer.getState().currentSong?.id).toBe('far');
    expect(acks()[0]?.ok).toBe(true);
  });

  it('acks false when the song exists nowhere', async () => {
    handlePlayerCommand(event({ command: 'play', song_id: 'ghost' }), Date.now());
    await waitForAck();

    expect(acks()[0]).toMatchObject({ ok: false, message: '找不到这首歌' });
    expect(usePlayer.getState().currentSong).toBeNull();
  });

  // The §4.3 matrix row changed in M5-9: a remote play of a fileless song is
  // accepted and starts a download.
  it('acks ok for a song with no file and starts the download', async () => {
    useLibrary.setState({ songs: [song('nofile', { has_file: false })] });
    handlePlayerCommand(event({ command: 'play', song_id: 'nofile' }), Date.now());
    await waitForAck();

    expect(acks()[0]).toMatchObject({ ok: true, message: '正在下载，完成后自动播放' });
    expect(
      calls.some((c) => c.method === 'POST' && c.url.endsWith('/songs/nofile/ensure-file')),
    ).toBe(true);
  });
});

describe('play-playlist / switch-playlist', () => {
  it('keeps the current view when the playlist cannot be loaded', async () => {
    playlistMembers = null;
    handlePlayerCommand(event({ command: 'play-playlist', playlist_id: PLAYLIST_ID }), Date.now());
    await waitForAck();

    expect(useLibrary.getState().playlistId).toBe(VIRTUAL_ALL_PLAYLIST_ID);
    expect(acks()[0]).toMatchObject({ ok: false, message: '歌单加载失败' });
  });

  it('switches the view but acks false for an empty playlist', async () => {
    playlistMembers = [];
    handlePlayerCommand(event({ command: 'play-playlist', playlist_id: PLAYLIST_ID }), Date.now());
    await waitForAck();

    expect(useLibrary.getState().playlistId).toBe(PLAYLIST_ID);
    expect(acks()[0]).toMatchObject({ ok: false, message: '歌单是空的' });
  });

  it('plays the first song with a file', async () => {
    playlistMembers = [song('x', { has_file: false }), song('y')];
    handlePlayerCommand(event({ command: 'play-playlist', playlist_id: PLAYLIST_ID }), Date.now());
    await waitForAck();

    expect(useLibrary.getState().songs.map((s) => s.id)).toEqual(['x', 'y']);
    expect(usePlayer.getState().currentSong?.id).toBe('y');
    expect(acks()[0]?.ok).toBe(true);
  });

  it('keeps the switched view even when the requested song is missing', async () => {
    playlistMembers = [song('x')];
    handlePlayerCommand(
      event({ command: 'play-playlist', playlist_id: PLAYLIST_ID, song_id: 'ghost' }),
      Date.now(),
    );
    await waitForAck();

    expect(useLibrary.getState().playlistId).toBe(PLAYLIST_ID);
    expect(usePlayer.getState().currentSong).toBeNull();
    expect(acks()[0]).toMatchObject({ ok: false, message: '找不到这首歌' });
  });

  it('switch-playlist only switches, and clears an active search', async () => {
    useLibrary.setState({ search: '旧关键词' });
    playlistMembers = [song('x')];
    handlePlayerCommand(
      event({ command: 'switch-playlist', playlist_id: PLAYLIST_ID }),
      Date.now(),
    );
    await waitForAck();

    expect(useLibrary.getState().playlistId).toBe(PLAYLIST_ID);
    expect(useLibrary.getState().search).toBe('');
    expect(usePlayer.getState().currentSong).toBeNull();
    expect(acks()[0]?.ok).toBe(true);
  });
});

describe('simple commands', () => {
  it('clamps a seek past the end and acks true', async () => {
    usePlayer.setState({ currentSong: song('a'), duration: 60 });
    handlePlayerCommand(event({ command: 'seek', position: 900 }), Date.now());
    await waitForAck();

    expect(usePlayer.getState().currentTime).toBe(60);
    expect(acks()[0]?.ok).toBe(true);
  });

  it('treats resume with nothing loaded as a successful no-op', async () => {
    handlePlayerCommand(event({ command: 'resume' }), Date.now());
    await waitForAck();
    expect(acks()[0]?.ok).toBe(true);
  });

  it('applies a mode change', async () => {
    handlePlayerCommand(event({ command: 'mode', mode: 'shuffle' }), Date.now());
    await waitForAck();

    expect(usePlayer.getState().playMode).toBe('shuffle');
    expect(acks()[0]?.ok).toBe(true);
  });
});

describe('ordering and deadlines', () => {
  it('runs two commands in arrival order rather than interleaving them', async () => {
    const first = event({ command: 'play', song_id: 'a' });
    const second = event({ command: 'pause' });
    handlePlayerCommand(first, Date.now());
    handlePlayerCommand(second, Date.now());
    await waitForAck(2);

    expect(acks().map((ack) => ack.request_id)).toEqual([first.request_id, second.request_id]);
    // Last intent wins: the pause is not overwritten by the play that was
    // still awaiting audio.play().
    expect(usePlayer.getState().intentPlaying).toBe(false);
  });

  it('drops a command that missed its deadline — no execution, no ack', async () => {
    handlePlayerCommand(
      event({ command: 'play', song_id: 'a' }),
      Date.now() - COMMAND_DEADLINE_MS - 100,
    );
    // Give the queue every chance to run it.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(acks()).toHaveLength(0);
    expect(usePlayer.getState().currentSong).toBeNull();
  });
});
