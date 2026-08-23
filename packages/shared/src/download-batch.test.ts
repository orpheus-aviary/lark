// The counter both hosts show (N4f-1, decision h).
//
// It came here with the function: the case below is the desktop store's, and
// the two after it are what a second reader of the same number needs pinned —
// a settled item counts however it settled, which is the difference between a
// batch that finishes at 3/3 and one that sits at 2/3 with nothing left to run.

import { describe, expect, it } from 'vitest';
import { batchProgress } from './download-batch.js';
import type { DownloadBatchData, DownloadBatchItemData } from './types.js';

const item = (
  index: number,
  taskId: string,
  final: DownloadBatchItemData['final'] = null,
): DownloadBatchItemData => ({ index, task_id: taskId, final });

const settled = (state: 'succeeded' | 'failed' | 'cancelled') => ({
  state,
  error_code: state === 'succeeded' ? null : 'DOWNLOAD_FAILED',
  song_id: state === 'succeeded' ? 's' : null,
});

const batch = (items: readonly DownloadBatchItemData[]): DownloadBatchData => ({
  id: 'b1',
  target: { kind: 'all' },
  total: items.length,
  items,
  created_at: 0,
});

describe('batchProgress', () => {
  it('counts a batch by its settled items', () => {
    const batches = [batch([item(0, 't1', settled('succeeded')), item(1, 't2'), item(2, 't3')])];

    expect(batchProgress(batches, 't2')).toMatchObject({ done: 1 });
    expect(batchProgress(batches, 'unrelated')).toBeNull();
  });

  it('counts a failed and a cancelled item as settled', () => {
    const batches = [
      batch([
        item(0, 't1', settled('succeeded')),
        item(1, 't2', settled('failed')),
        item(2, 't3', settled('cancelled')),
      ]),
    ];

    // 3/3 and done. A counter that only believed successes would leave this
    // batch reading 1/3 with nothing left that could ever move it.
    expect(batchProgress(batches, 't1')).toMatchObject({ done: 3 });
  });

  it('answers from whichever batch owns the task', () => {
    const other: DownloadBatchData = { ...batch([item(0, 'x1')]), id: 'b0' };
    const mine = batch([item(0, 't1', settled('succeeded')), item(1, 't2')]);

    const found = batchProgress([other, mine], 't2');
    expect(found?.batch.id).toBe('b1');
    expect(found?.done).toBe(1);
  });
});
