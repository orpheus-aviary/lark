// The pending play intent (M5-9). Every case here is a way the protocol could
// hang or play the wrong song: a completion nobody announced, a task that
// vanished, a user who changed their mind, a daemon that restarted.

import type { DownloadTaskData, SongData } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDownloads } from '../stores/download.js';
import { useLibrary } from '../stores/library.js';
import { usePlayer } from '../stores/player.js';
import { useViewPrefs } from '../stores/view-prefs.js';
import type { MediaElement } from './media.js';
import { clearPending, invalidatePending, pendingIntent, reconcilePending } from './pending.js';

function fakeMedia(): MediaElement {
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

function task(id: string, state: DownloadTaskData['state'], songId: string): DownloadTaskData {
  return {
    id,
    kind: 'ensure-file',
    state,
    stage: null,
    revision: 1,
    input: { type: 'song', song_id: songId },
    song_id: songId,
    playlist_ids: [],
    failed_playlist_ids: [],
    created_at: 0,
    started_at: 0,
    finished_at: null,
    error_code: null,
    error_message: null,
    result: state === 'succeeded' ? { song_id: songId } : null,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let calls: Call[] = [];
/** Task ids handed out by `POST /songs/:id/ensure-file`, in order. */
let taskIds: string[] = [];
/** What `GET /download/tasks` answers. */
let snapshot: DownloadTaskData[] = [];
let audio: MediaElement;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SONG_URL = /\/songs\/([\w-]+)$/;

beforeEach(() => {
  calls = [];
  taskIds = ['task-1', 'task-2'];
  snapshot = [];
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
      if (url.includes('/ensure-file')) {
        const taskId = taskIds.shift() as string;
        const songId = url.split('/songs/')[1]?.split('/')[0] as string;
        // The daemon knows about the task the moment it answers, so the
        // snapshot the client pulls next has it too.
        snapshot = [...snapshot, task(taskId, 'queued', songId)];
        return Promise.resolve(jsonResponse({ success: true, data: { task_id: taskId } }));
      }
      if (url.endsWith('/download/tasks')) {
        return Promise.resolve(
          jsonResponse({ success: true, data: { tasks: snapshot, batches: [] } }),
        );
      }
      const match = SONG_URL.exec(url);
      if (match && method === 'GET') {
        // The song is fetched fresh AFTER the download, so it has its file now.
        return Promise.resolve(jsonResponse({ success: true, data: song(match[1] as string) }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    }),
  );

  window.localStorage.clear();
  audio = fakeMedia();
  clearPending();
  useViewPrefs.setState({
    columns: { duration: false, fileSize: false, createdAt: false },
    widths: {},
    sort: { field: 'default', order: 'asc' },
  });
  useLibrary.setState({
    songs: [],
    playlistId: VIRTUAL_ALL_PLAYLIST_ID,
    search: '',
    loading: false,
    error: null,
  });
  useDownloads.setState({ tasks: [], batches: [], cancelling: [] });
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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Ask to play a song whose file is gone, and settle the request. */
async function playMissing(id = 'gone'): Promise<void> {
  await usePlayer.getState().play(song(id, { has_file: false }));
  await flush();
}

const posted = (fragment: string): Call[] =>
  calls.filter((call) => call.method === 'POST' && call.url.includes(fragment));

describe('requesting a pending play', () => {
  it('remembers the task and the song', async () => {
    await playMissing();
    expect(pendingIntent()).toMatchObject({ taskId: 'task-1', songId: 'gone' });
    expect(usePlayer.getState().currentSong).toBeNull();
  });

  it('reconciles against a snapshot right away — a zero-network task may be done', async () => {
    snapshot = [task('task-1', 'succeeded', 'gone')];
    await playMissing();
    await flush();

    expect(usePlayer.getState().currentSong?.id).toBe('gone');
    expect(pendingIntent()).toBeNull();
  });
});

describe('settling the intent', () => {
  it('plays the song once the task succeeds', async () => {
    await playMissing();
    reconcilePending([task('task-1', 'succeeded', 'gone')]);
    await flush();

    expect(usePlayer.getState().currentSong?.id).toBe('gone');
    expect(audio.src).toContain('gone');
    expect(pendingIntent()).toBeNull();
  });

  it('keeps waiting while the task is still running', async () => {
    await playMissing();
    reconcilePending([task('task-1', 'running', 'gone')]);
    await flush();

    expect(pendingIntent()).not.toBeNull();
    expect(usePlayer.getState().currentSong).toBeNull();
  });

  it('gives up on a failed task instead of playing', async () => {
    await playMissing();
    reconcilePending([{ ...task('task-1', 'failed', 'gone'), error_message: '源已失效' }]);
    await flush();

    expect(pendingIntent()).toBeNull();
    expect(usePlayer.getState().currentSong).toBeNull();
  });

  it('clears a task the snapshot has never heard of, rather than waiting forever', async () => {
    await playMissing();
    reconcilePending([task('someone-elses-task', 'running', 'other')]);

    expect(pendingIntent()).toBeNull();
  });

  it('settles through an ordinary task refresh (the SSE-outage path)', async () => {
    await playMissing();
    snapshot = [task('task-1', 'succeeded', 'gone')];

    useDownloads.getState().refresh();
    await flush();
    await flush();

    expect(usePlayer.getState().currentSong?.id).toBe('gone');
  });
});

describe('what retires an intent', () => {
  it('a second play supersedes the first, cancels it, and only the last one plays', async () => {
    await playMissing('first');
    await playMissing('second');

    expect(posted('/download/cancel')[0]?.body).toEqual({ task_id: 'task-1' });
    expect(pendingIntent()).toMatchObject({ taskId: 'task-2', songId: 'second' });

    // The superseded task is allowed to finish (it may be past its commit
    // point) — it just must not play. Snapshots carry every task, which is
    // what makes "my task is not in here" mean the task is really gone.
    reconcilePending([task('task-1', 'succeeded', 'first'), task('task-2', 'queued', 'second')]);
    await flush();
    expect(usePlayer.getState().currentSong).toBeNull();

    reconcilePending([task('task-1', 'succeeded', 'first'), task('task-2', 'succeeded', 'second')]);
    await flush();
    expect(usePlayer.getState().currentSong?.id).toBe('second');
  });

  it.each([
    ['pause', () => usePlayer.getState().pause()],
    ['next', () => usePlayer.getState().next()],
    ['prev', () => usePlayer.getState().prev()],
    ['a new daemon generation', () => Promise.resolve(invalidatePending())],
  ])('%s stops the finished download from playing', async (_label, action) => {
    await playMissing();
    await action();
    reconcilePending([task('task-1', 'succeeded', 'gone')]);
    await flush();

    expect(pendingIntent()).toBeNull();
    expect(usePlayer.getState().currentSong).toBeNull();
  });

  it('checks the generation INSIDE the queue slot, not only before the fetch', async () => {
    await playMissing();
    // The completion arrives, and the user picks another song while the song
    // fetch is still in flight: the click is already queued behind it.
    reconcilePending([task('task-1', 'succeeded', 'gone')]);
    useLibrary.setState({ songs: [song('other')] });
    await usePlayer.getState().play(song('other'));
    await flush();
    await flush();

    expect(usePlayer.getState().currentSong?.id).toBe('other');
  });
});
