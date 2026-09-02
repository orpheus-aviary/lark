// The bug a screen cannot show you (N4d-2, rebuilt in 0.1.1 ⑦).
//
// A `FlatList` renders what fits; a row sorted off the bottom looks exactly
// like a row that is not there. On the device this cost an afternoon: a
// cancelled download reported 「已取消」 and then could not be found in the
// list, because the engine hands back INSERTION ORDER and the screen kept the
// first twenty — the oldest — instead of the most recent.
//
// What the page shows changed in 0.1.1: finished work comes from the
// persistent history rather than from the engine's ring, so the ordering
// question moved with it. The same class of bug is still the one to look for
// — a group that renders in the wrong place, or not at all.

import { type DownloadRecord, failedRecords } from '@lark/core/portable';
import type { DownloadBatchData, DownloadTaskData } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { downloadListRows, latestBatch } from './rows';

function task(
  id: string,
  state: DownloadTaskData['state'],
  finishedAt: number | null = null,
): DownloadTaskData {
  return {
    id,
    kind: 'download',
    state,
    stage: state === 'running' ? 'downloading' : null,
    revision: 1,
    input: { type: 'url', url: `https://b23.tv/${id}` },
    origin: { kind: 'video', url: `https://b23.tv/${id}` },
    song_id: null,
    playlist_ids: [],
    failed_playlist_ids: [],
    created_at: 0,
    started_at: null,
    finished_at: finishedAt,
    error_code: null,
    error_message: null,
    result: null,
    received_bytes: 0,
    total_bytes: null,
    title: id,
    artist: null,
    ...(state === 'running' ? { started_at: 0 } : {}),
  };
}

const record = (id: string, patch: Partial<DownloadRecord> = {}): DownloadRecord => ({
  id,
  kind: 'download',
  state: 'succeeded',
  title: id,
  artist: null,
  input: { type: 'url', url: `https://b23.tv/${id}` },
  playlist_ids: [],
  song_id: null,
  error_code: null,
  error_message: null,
  finished_at: 1,
  ...patch,
});

const keys = (rows: readonly { key: string }[]) => rows.map((row) => row.key);

describe('the page, top to bottom', () => {
  it('splits what is running from what is waiting, above what has finished', () => {
    const rows = downloadListRows(
      [task('now', 'running'), task('next', 'queued'), task('done', 'succeeded', 9)],
      [record('r1')],
    );
    expect(keys(rows)).toEqual([
      'head:running',
      'task:now',
      'head:queued',
      'task:next',
      'head:records',
      'record:r1',
    ]);
  });

  it('tells each row which group it landed in', () => {
    const rows = downloadListRows([task('now', 'running'), task('next', 'queued')], []);
    const tasks = rows.filter((row) => row.kind === 'task');
    expect(tasks.map((row) => [row.task.id, row.section])).toEqual([
      ['now', 'running'],
      ['next', 'queued'],
    ]);
  });

  it('takes finished work from the history and NOT from the engine', () => {
    // The engine's ring still holds `done`; the page must not draw it twice,
    // nor draw it at all except through a record.
    const rows = downloadListRows([task('done', 'succeeded', 9)], []);
    expect(keys(rows).filter((key) => key.startsWith('task:'))).toEqual([]);
  });

  it('keeps the queue in the order the engine gave it', () => {
    // The oldest queued task is the one actually running, so insertion order
    // puts it on top by itself — reversing here would hide it.
    const rows = downloadListRows(
      [task('a', 'running'), task('b', 'queued'), task('c', 'queued')],
      [],
    );
    expect(keys(rows)).toEqual([
      'head:running',
      'task:a',
      'head:queued',
      'task:b',
      'task:c',
      'head:records',
      'empty:records',
    ]);
  });

  it('keeps records in the order the history gave them', () => {
    const rows = downloadListRows([], [record('new'), record('old')]);
    expect(keys(rows).slice(-3)).toEqual(['head:records', 'record:new', 'record:old']);
  });

  it('draws every heading even with nothing under it, and says so', () => {
    // 用户, 2026-09-02, and a divergence from the desktop: this page IS the
    // screen, so 「没有排队的任务」 is an answer somebody came here for.
    const rows = downloadListRows([], []);
    expect(keys(rows)).toEqual([
      'head:running',
      'empty:running',
      'head:queued',
      'empty:queued',
      'head:records',
      'empty:records',
    ]);
    expect(rows.filter((row) => row.kind === 'empty').map((row) => row.text)).toEqual([
      '没有正在下载的歌',
      '没有排队的任务',
      '还没有下载记录',
    ]);
  });

  it('counts what is under each heading', () => {
    const rows = downloadListRows([task('a', 'queued'), task('b', 'queued')], [record('r')]);
    const heads = rows.filter((row) => row.kind === 'head');
    expect(heads.map((row) => [row.section, row.count])).toEqual([
      ['running', 0],
      ['queued', 2],
      ['records', 1],
    ]);
  });
});

describe('failedRecords', () => {
  it('is what 全部重试 is about, and nothing else', () => {
    const rows = failedRecords([
      record('ok'),
      record('bad', { state: 'failed' }),
      record('gone', { state: 'cancelled' }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(['bad']);
  });
});

describe('latestBatch', () => {
  const batch = (id: string, createdAt: number): DownloadBatchData => ({
    id,
    target: { kind: 'all' },
    total: 1,
    items: [{ index: 0, task_id: `t-${id}`, final: null }],
    created_at: createdAt,
  });

  it('is null when nothing has been submitted', () => {
    expect(latestBatch([])).toBeNull();
  });

  it('picks the newest by created_at, not by position', () => {
    // The engine hands back registry order; a screen reading `at(-1)` would be
    // trusting a detail it does not own — the same mistake as the rows above.
    expect(latestBatch([batch('new', 9), batch('old', 2)])?.id).toBe('new');
  });

  it('takes the later entry when two share a millisecond', () => {
    expect(latestBatch([batch('first', 5), batch('second', 5)])?.id).toBe('second');
  });
});

// ── 0.5.1 · the continuation of a song that just finished ────────────────
//
// Same class of bug as the one this file was written for: a row in the wrong
// place. `lyrics` is a SEPARATE task spawned when a download succeeds, so it
// is always the newest thing in the engine's Map — and insertion order put it
// under every download still running, where a `FlatList` may not reach it.
describe('a lyrics continuation', () => {
  const parent = { ...task('dl-early', 'succeeded', 200), song_id: 'song-1', started_at: 100 };
  const stillGoing = { ...task('dl-late', 'running'), created_at: 500, started_at: 500 };
  const lyrics = {
    ...task('ly', 'running'),
    kind: 'lyrics' as const,
    stage: 'lyrics' as const,
    song_id: 'song-1',
    created_at: 900,
    started_at: 900,
  };

  it('is listed with its own song, not under everything still running', () => {
    // Insertion order, which is what the engine hands back. Both are running,
    // so both are in the same group and the order between them is the point.
    const rows = downloadListRows([parent, stillGoing, lyrics], []);
    const tasks = rows.filter((row) => row.kind === 'task').map((row) => row.task.id);
    expect(tasks).toEqual(['ly', 'dl-late']);
  });
});
