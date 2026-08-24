// Criterion 35 (N4g-1): latest-wins, and the queue snapshot.
//
// The device can be shown "A did not steal the speaker from B" once, by hand,
// with a real download in between. What it cannot show is that the RULE is
// there — a single run of a race proves nothing about the run that matters —
// so the reverse test lives here (§8.5, the testing scale): a controller wired
// to ignore the generation MUST steal, and the case below asserts that it does.
//
// Everything is injected, so nothing in this file touches React Native, the
// engine or a database.

import type { DownloadTaskData, SongData } from '@lark/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlayQueue } from '../player/queue';
import { type EnsureDeps, createEnsureController } from './ensure';

const song = (id: string, name = id.toUpperCase()): SongData =>
  ({
    id,
    name,
    artist: '',
    duration: 100,
    has_file: false,
  }) as SongData;

const queue = (...ids: string[]): PlayQueue => ({ source: { kind: 'all' }, songIds: ids });

const task = (id: string, patch: Partial<DownloadTaskData> = {}): DownloadTaskData =>
  ({
    id,
    kind: 'ensure-file',
    state: 'queued',
    error_message: null,
    ...patch,
  }) as DownloadTaskData;

/** The player's counter, as the store implements it. */
let intent: number;
let enqueued: string[];
let cancelled: string[];
let played: { song: SongData; queue: PlayQueue }[];
let said: string[];
let library: Record<string, SongData | undefined>;
let visible: PlayQueue | null;
let nextTaskId: string;
let throwOnEnqueue: Error | null;

const deps = (patch: Partial<EnsureDeps> = {}): EnsureDeps => ({
  claimIntent: () => {
    intent += 1;
    return intent;
  },
  holdsIntent: (mine) => mine === intent,
  enqueue: (songId) => {
    if (throwOnEnqueue !== null) throw throwOnEnqueue;
    enqueued.push(songId);
    return task(nextTaskId);
  },
  cancelTask: (taskId) => cancelled.push(taskId),
  getSong: (songId) => library[songId] ?? null,
  // The assembly's rule (`App.tsx`): the list on screen if it holds this song,
  // the list it was tapped in otherwise.
  queueFor: (target, tapped) => {
    const shown = visible ?? tapped;
    return shown.songIds.includes(target.id) ? shown : tapped;
  },
  play: (target, playQueue) => played.push({ song: target, queue: playQueue }),
  say: (message) => said.push(message),
  ...patch,
});

beforeEach(() => {
  intent = 0;
  enqueued = [];
  cancelled = [];
  played = [];
  said = [];
  library = { a: { ...song('a'), has_file: true }, b: { ...song('b'), has_file: true } };
  visible = null;
  nextTaskId = 'task-a';
  throwOnEnqueue = null;
});

describe('one tap, waiting for its file', () => {
  it('queues the fetch, holds the intent, and shows what it is waiting for', () => {
    const ensure = createEnsureController(deps());
    ensure.request(song('a'), queue('a', 'b'));

    expect(enqueued).toEqual(['a']);
    expect(ensure.getState()).toEqual({ songId: 'a', name: 'A' });
    expect(said).toEqual(['正在获取《A》']);
    expect(played).toEqual([]);
  });

  it('plays it when the task succeeds, and stops waiting', () => {
    const ensure = createEnsureController(deps());
    ensure.request(song('a'), queue('a', 'b'));

    ensure.reconcile([task('task-a', { state: 'running' })]);
    expect(ensure.getState()).not.toBeNull();

    ensure.reconcile([task('task-a', { state: 'succeeded' })]);
    expect(played).toHaveLength(1);
    expect(played[0]?.song.id).toBe('a');
    expect(ensure.getState()).toBeNull();
  });

  it('plays the song the LIBRARY has, not the row that was tapped', () => {
    const ensure = createEnsureController(deps());
    ensure.request(song('a', '原标题'), queue('a'));
    // Between the tap and the file arriving, the row was renamed and its
    // `has_file` became true — the tapped copy says neither.
    library.a = { ...song('a', '干净的名字'), has_file: true };

    ensure.reconcile([task('task-a', { state: 'succeeded' })]);
    expect(played[0]?.song.name).toBe('干净的名字');
    expect(played[0]?.song.has_file).toBe(true);
  });

  it('is idempotent: a second snapshot of the same success plays nothing more', () => {
    const ensure = createEnsureController(deps());
    ensure.request(song('a'), queue('a'));

    const done = [task('task-a', { state: 'succeeded' })];
    ensure.reconcile(done);
    ensure.reconcile(done);
    expect(played).toHaveLength(1);
  });

  it('says so when the fetch fails, and gives up', () => {
    const ensure = createEnsureController(deps());
    ensure.request(song('a'), queue('a'));

    ensure.reconcile([task('task-a', { state: 'failed', error_message: '来源没了' })]);
    expect(played).toEqual([]);
    expect(ensure.getState()).toBeNull();
    expect(said.at(-1)).toBe('没能拿回《A》：来源没了');
  });

  it('stops waiting for a task the snapshot no longer knows about', () => {
    // Aged out of the engine's terminal ring, or a process that restarted
    // underneath. Waiting forever is the one outcome to avoid.
    const ensure = createEnsureController(deps());
    ensure.request(song('a'), queue('a'));

    ensure.reconcile([task('somebody-else', { state: 'running' })]);
    expect(ensure.getState()).toBeNull();
    expect(played).toEqual([]);
  });

  it('refuses out loud when the queue will not take it, and claims nothing', () => {
    throwOnEnqueue = new Error('下载队列已满');
    const ensure = createEnsureController(deps());
    ensure.request(song('a'), queue('a'));

    expect(said).toEqual(['下载队列已满']);
    expect(ensure.getState()).toBeNull();
    // The intent is untouched: a refused fetch must not abandon the load that
    // some other tap has in flight.
    expect(intent).toBe(0);
  });

  it('reports a song that was deleted while its file was being fetched', () => {
    const ensure = createEnsureController(deps());
    ensure.request(song('a'), queue('a'));
    library.a = undefined;

    ensure.reconcile([task('task-a', { state: 'succeeded' })]);
    expect(played).toEqual([]);
    expect(said.at(-1)).toBe('《A》已经不在曲库里了');
  });
});

describe('latest wins (criterion 35)', () => {
  it('a song played while the fetch runs keeps the speaker', () => {
    const ensure = createEnsureController(deps());
    ensure.request(song('a'), queue('a', 'b'));

    // The user tapped B, which has its file: `player.play` claims the newest
    // intent, exactly as this controller's `claimIntent` did.
    intent += 1;

    ensure.reconcile([task('task-a', { state: 'succeeded' })]);
    expect(played).toEqual([]); // A landed in the library and nothing else
    expect(ensure.getState()).toBeNull();
  });

  it('stops promising the moment something else speaks for the speaker', () => {
    // Decision j: the wait row is a promise ("完成后播放"), and a deliberate
    // pause or another song makes it one nobody will keep. It goes away on the
    // next reconcile — which the player drives, so "the next" is immediate.
    const ensure = createEnsureController(deps());
    ensure.request(song('a'), queue('a', 'b'));
    intent += 1;

    ensure.reconcile([task('task-a', { state: 'running' })]);
    expect(ensure.getState()).toBeNull();
    // The download it started is NOT cancelled: it was asked for, and it
    // belongs in the library either way.
    expect(cancelled).toEqual([]);
  });

  it('REVERSE: a controller that ignores the generation steals it', () => {
    // The mutation the device cannot demonstrate. If `holdsIntent` stops being
    // consulted — the one line — the case above goes green while the phone
    // hijacks the speaker a minute after somebody moved on.
    const ensure = createEnsureController(deps({ holdsIntent: () => true }));
    ensure.request(song('a'), queue('a', 'b'));
    intent += 1;

    ensure.reconcile([task('task-a', { state: 'succeeded' })]);
    expect(played).toHaveLength(1);
  });

  it('a second tap on another missing song replaces the first intent', () => {
    const ensure = createEnsureController(deps());
    ensure.request(song('a'), queue('a', 'b'));
    nextTaskId = 'task-b';
    ensure.request(song('b'), queue('a', 'b'));

    expect(ensure.getState()).toEqual({ songId: 'b', name: 'B' });
    // A's download is NOT cancelled — it finishes and lands in the library.
    expect(cancelled).toEqual([]);

    ensure.reconcile([
      task('task-a', { state: 'succeeded' }),
      task('task-b', { state: 'succeeded' }),
    ]);
    expect(played.map((entry) => entry.song.id)).toEqual(['b']);
  });
});

describe('the queue is taken when playback starts (criterion 35②)', () => {
  it('uses the list on screen at that moment, not the one that was tapped', () => {
    const ensure = createEnsureController(deps());
    // Tapped inside a playlist…
    ensure.request(song('a'), { source: { kind: 'playlist', id: 'p1' }, songIds: ['a', 'b'] });
    // …and by the time the file arrives, 歌曲 is on screen, sorted the other way.
    visible = queue('c', 'b', 'a');

    ensure.reconcile([task('task-a', { state: 'succeeded' })]);
    expect(played[0]?.queue).toEqual(queue('c', 'b', 'a'));
  });

  it('falls back to the list it was tapped in when what is on screen has no room for it', () => {
    const ensure = createEnsureController(deps());
    const tapped: PlayQueue = { source: { kind: 'playlist', id: 'p1' }, songIds: ['a', 'b'] };
    ensure.request(song('a'), tapped);
    // A list that does not hold this song — a different playlist, a search
    // that filtered it out — is not a queue it can play out of.
    visible = queue('x', 'y');

    ensure.reconcile([task('task-a', { state: 'succeeded' })]);
    expect(played[0]?.queue).toEqual(tapped);
  });

  it('falls back when what is on screen is not a list at all', () => {
    const ensure = createEnsureController(deps());
    const tapped = queue('a', 'b');
    ensure.request(song('a'), tapped);
    visible = null; // 设置, the add page, the full-screen player…

    ensure.reconcile([task('task-a', { state: 'succeeded' })]);
    expect(played[0]?.queue).toEqual(tapped);
  });
});

describe('giving up on the wait', () => {
  it('drops the intent and asks the engine to stop', () => {
    const ensure = createEnsureController(deps());
    ensure.request(song('a'), queue('a'));

    ensure.cancel();
    expect(ensure.getState()).toBeNull();
    expect(cancelled).toEqual(['task-a']);
  });

  it('a task that finishes anyway plays nothing', () => {
    // The refusal case: past the commit point, `cancel` is answered with
    // 「已经在落盘，停不下来」 and the download completes. The file lands, and
    // that is all it does.
    const ensure = createEnsureController(deps());
    ensure.request(song('a'), queue('a'));
    ensure.cancel();

    ensure.reconcile([task('task-a', { state: 'succeeded' })]);
    expect(played).toEqual([]);
  });

  it('is harmless with nothing waiting', () => {
    const ensure = createEnsureController(deps());
    ensure.cancel();
    expect(cancelled).toEqual([]);
  });
});

describe('what the mini bar subscribes to', () => {
  it('notifies on every change, and hands back a stable value between them', () => {
    const ensure = createEnsureController(deps());
    let notifications = 0;
    const stop = ensure.subscribe(() => {
      notifications += 1;
    });

    ensure.request(song('a'), queue('a'));
    expect(notifications).toBe(1);
    const first = ensure.getState();
    // `useSyncExternalStore` compares with `Object.is`: a fresh object per read
    // would re-render forever.
    expect(ensure.getState()).toBe(first);

    ensure.reconcile([task('task-a', { state: 'running' })]);
    expect(notifications).toBe(1); // nothing changed for a watcher

    ensure.reconcile([task('task-a', { state: 'succeeded' })]);
    expect(notifications).toBe(2);
    expect(ensure.getState()).toBeNull();

    stop();
    ensure.request(song('b'), queue('b'));
    expect(notifications).toBe(2);
  });
});
