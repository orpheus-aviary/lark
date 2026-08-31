// The order the download page lists what is running (0.5.1，用户报的
// 「匹配歌词阶段不应该沉到下面」).

import type { DownloadTaskData } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { orderedTasks, queuedAt } from './task-order.js';

function task(over: Partial<DownloadTaskData> & { id: string }): DownloadTaskData {
  return {
    kind: 'download',
    state: 'running',
    stage: 'downloading',
    revision: 1,
    input: { type: 'url', url: 'https://x' },
    origin: { kind: 'video', url: 'https://x' },
    song_id: null,
    playlist_ids: [],
    failed_playlist_ids: [],
    created_at: 0,
    started_at: null,
    finished_at: null,
    error_code: null,
    error_message: null,
    title: null,
    artist: null,
    received_bytes: 0,
    total_bytes: null,
    result: null,
    ...over,
  } as DownloadTaskData;
}

describe('a lyrics continuation is the tail of its download', () => {
  // The reported shape: one song finishes early in a batch, and the lyrics
  // task it spawns is the newest thing in the queue.
  const parent = task({
    id: 'dl-early',
    state: 'succeeded',
    song_id: 'song-1',
    created_at: 100,
    started_at: 100,
  });
  const stillGoing = task({ id: 'dl-late', created_at: 500, started_at: 500 });
  const lyrics = task({
    id: 'ly',
    kind: 'lyrics',
    stage: 'lyrics',
    song_id: 'song-1',
    created_at: 900,
    started_at: 900,
  });

  it('sorts with the song it belongs to, not with its own arrival', () => {
    const all = [parent, stillGoing, lyrics];
    expect(orderedTasks([stillGoing, lyrics], all).map((t) => t.id)).toEqual(['ly', 'dl-late']);
  });

  it('reads its position off the download it continues', () => {
    expect(queuedAt(lyrics, [parent, stillGoing, lyrics])).toBe(100);
  });

  // 🔴 The counter-test. Before 0.5.1 both ends sorted by the task's own
  // moment, and that is exactly what put 「匹配歌词」 under everything else.
  it('would sink to the bottom on its own moment', () => {
    const own = (t: DownloadTaskData): number => t.started_at ?? t.created_at;
    expect([stillGoing, lyrics].sort((a, b) => own(a) - own(b)).map((t) => t.id)).toEqual([
      'dl-late',
      'ly',
    ]);
  });

  it('falls back to its own moment when the download has aged out of the ring', () => {
    // No parent in the snapshot: the question can no longer be answered better.
    expect(queuedAt(lyrics, [stillGoing, lyrics])).toBe(900);
    expect(orderedTasks([stillGoing, lyrics], [stillGoing, lyrics]).map((t) => t.id)).toEqual([
      'dl-late',
      'ly',
    ]);
  });

  it('leaves ordinary downloads in queue order', () => {
    const all = [stillGoing, parent];
    expect(orderedTasks(all, all).map((t) => t.id)).toEqual(['dl-early', 'dl-late']);
  });

  // 🔴 THE GUARD THAT SAYS "NOT MYSELF". `find` walks the snapshot in whatever
  // order it arrives, and a lyrics task carries the same `song_id` as the
  // download it continues — so without `kind !== 'lyrics'` a snapshot that
  // happens to list the continuation first makes it its own parent, and the
  // whole rule quietly becomes a no-op. Discovered by breaking it: with the
  // parent listed first, removing the guard changes nothing.
  it('does not take itself for the download it continues', () => {
    const all = [lyrics, parent, stillGoing];
    expect(queuedAt(lyrics, all)).toBe(100);
    expect(orderedTasks([stillGoing, lyrics], all).map((t) => t.id)).toEqual(['ly', 'dl-late']);
  });

  it('does not reorder a lyrics task that names no song', () => {
    const orphan = task({ id: 'ly2', kind: 'lyrics', created_at: 900, started_at: 900 });
    expect(queuedAt(orphan, [parent, orphan])).toBe(900);
  });
});
