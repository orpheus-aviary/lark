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
  it('shows what is running above what has finished', () => {
    const rows = downloadListRows(
      [task('now', 'running'), task('done', 'succeeded', 9)],
      [record('r1')],
    );
    expect(keys(rows)).toEqual(['head:tasks', 'task:now', 'head:records', 'record:r1']);
  });

  it('takes finished work from the history and NOT from the engine', () => {
    // The engine's ring still holds `done`; the page must not draw it twice,
    // nor draw it at all except through a record.
    const rows = downloadListRows([task('done', 'succeeded', 9)], []);
    expect(keys(rows)).toEqual(['head:tasks', 'empty:tasks']);
  });

  it('keeps the queue in the order the engine gave it', () => {
    // The oldest queued task is the one actually running, so insertion order
    // puts it on top by itself — reversing here would hide it.
    const rows = downloadListRows(
      [task('a', 'running'), task('b', 'queued'), task('c', 'queued')],
      [],
    );
    expect(keys(rows)).toEqual(['head:tasks', 'task:a', 'task:b', 'task:c']);
  });

  it('keeps records in the order the history gave them', () => {
    const rows = downloadListRows([], [record('new'), record('old')]);
    expect(keys(rows)).toEqual([
      'head:tasks',
      'empty:tasks',
      'head:records',
      'record:new',
      'record:old',
    ]);
  });

  it('hides the 下载记录 heading when there is nothing under it', () => {
    // Its heading carries 清空记录 and 全部重试; over an empty list both are
    // buttons that cannot do anything.
    const rows = downloadListRows([task('now', 'running')], []);
    expect(keys(rows)).not.toContain('head:records');
  });

  it('says so when nothing is downloading, rather than showing an empty page', () => {
    expect(keys(downloadListRows([], []))).toEqual(['head:tasks', 'empty:tasks']);
  });

  it('counts what is under each heading', () => {
    const rows = downloadListRows([task('a', 'queued'), task('b', 'queued')], [record('r')]);
    const heads = rows.filter((row) => row.kind === 'head');
    expect(heads.map((row) => (row.kind === 'head' ? row.count : -1))).toEqual([2, 1]);
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
