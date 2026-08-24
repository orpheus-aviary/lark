// The bug a screen cannot show you (N4d-2).
//
// A `FlatList` renders what fits; a row sorted off the bottom looks exactly
// like a row that is not there. On the device this cost an afternoon: a
// cancelled download reported 「已取消」 and then could not be found in the
// list, because the engine hands back INSERTION ORDER and the screen kept the
// first twenty — the oldest — instead of the most recent.

import type { DownloadBatchData, DownloadTaskData } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { TERMINAL_SHOWN, latestBatch, orderTaskRows } from './rows';

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

const ids = (rows: readonly DownloadTaskData[]) => rows.map((row) => row.id);

describe('reading order', () => {
  it('puts everything still working above everything finished', () => {
    const rows = orderTaskRows([task('done', 'succeeded', 100), task('now', 'running')]);
    expect(ids(rows)).toEqual(['now', 'done']);
  });

  it('keeps active tasks in the order they were queued', () => {
    // The running one is the oldest of them, so it lands on top by itself.
    const rows = orderTaskRows([task('a', 'running'), task('b', 'queued'), task('c', 'queued')]);
    expect(ids(rows)).toEqual(['a', 'b', 'c']);
  });

  it('shows the most recently finished task first — the engine gives OLDEST first', () => {
    // The engine's `snapshot()` walks a Map, so this array is registration
    // order. A screen that trusted it showed a cancel from five minutes ago
    // above the one that just happened.
    const rows = orderTaskRows([
      task('oldest', 'succeeded', 100),
      task('middle', 'failed', 200),
      task('newest', 'cancelled', 300),
    ]);
    expect(ids(rows)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('drops the OLDEST when there are more than fit, never the newest', () => {
    const many = Array.from({ length: TERMINAL_SHOWN + 5 }, (_, i) =>
      task(`t${i}`, 'succeeded', i),
    );
    const rows = orderTaskRows(many);

    expect(rows).toHaveLength(TERMINAL_SHOWN);
    // The whole point: the five that fell off are t0..t4, not the recent ones.
    expect(rows[0]?.id).toBe(`t${TERMINAL_SHOWN + 4}`);
    expect(ids(rows)).not.toContain('t0');
    expect(ids(rows)).toContain(`t${TERMINAL_SHOWN + 4}`);
  });

  it('never drops an active task, however many terminal ones there are', () => {
    const many = Array.from({ length: TERMINAL_SHOWN + 5 }, (_, i) =>
      task(`t${i}`, 'succeeded', i),
    );
    const rows = orderTaskRows([...many, task('now', 'running')]);
    expect(rows[0]?.id).toBe('now');
    expect(rows).toHaveLength(TERMINAL_SHOWN + 1);
  });

  it('sorts a task with no finish time last rather than to the top', () => {
    const rows = orderTaskRows([task('nofinish', 'failed', null), task('real', 'succeeded', 50)]);
    expect(ids(rows)).toEqual(['real', 'nofinish']);
  });

  it('does not mutate what it was given', () => {
    const given = [task('a', 'succeeded', 1), task('b', 'succeeded', 2)];
    orderTaskRows(given);
    expect(ids(given)).toEqual(['a', 'b']);
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
