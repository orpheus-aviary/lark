// A batch is allowed to be partly successful, and the report has to say so —
// "已删除 10 首" when two of them failed is the worst possible outcome.

import { describe, expect, it, vi } from 'vitest';
import { batchMessage, runBatch } from './batch-actions.js';

const describeError = (err: unknown): string => (err as Error).message;

describe('runBatch', () => {
  it('runs one at a time, in order — concurrency would just make them 409', async () => {
    const order: string[] = [];
    let live = 0;
    let peak = 0;

    await runBatch(
      ['a', 'b', 'c'],
      async (id) => {
        live++;
        peak = Math.max(peak, live);
        await Promise.resolve();
        order.push(id);
        live--;
      },
      describeError,
    );

    expect(order).toEqual(['a', 'b', 'c']);
    expect(peak).toBe(1);
  });

  it('keeps going after a failure and names the first one', async () => {
    const action = vi.fn((id: string) =>
      id === 'b' || id === 'c' ? Promise.reject(new Error(`${id} 炸了`)) : Promise.resolve(),
    );

    const outcome = await runBatch(['a', 'b', 'c', 'd'], action, describeError);

    expect(action).toHaveBeenCalledTimes(4);
    expect(outcome).toEqual({ total: 4, ok: 2, failed: 2, firstError: 'b 炸了' });
  });

  it('never rejects, whatever the action does', async () => {
    await expect(
      runBatch(['a'], () => Promise.reject(new Error('nope')), describeError),
    ).resolves.toMatchObject({ ok: 0, failed: 1 });
  });

  it('handles an empty selection as a no-op', async () => {
    const action = vi.fn(() => Promise.resolve());
    expect(await runBatch([], action, describeError)).toEqual({
      total: 0,
      ok: 0,
      failed: 0,
      firstError: null,
    });
    expect(action).not.toHaveBeenCalled();
  });
});

describe('batchMessage', () => {
  it('says the plain thing when everything worked', () => {
    expect(batchMessage({ total: 3, ok: 3, failed: 0, firstError: null }, '已固定')).toEqual({
      text: '已固定 3 首',
      ok: true,
    });
  });

  it('reports both halves of a partial batch, with a reason', () => {
    expect(
      batchMessage({ total: 3, ok: 1, failed: 2, firstError: '歌曲不存在' }, '已删除'),
    ).toEqual({ text: '已删除 1 首，2 首失败：歌曲不存在', ok: false });
  });

  it('does not pretend anything happened when nothing did', () => {
    expect(batchMessage({ total: 2, ok: 0, failed: 2, firstError: '连不上' }, '已移除')).toEqual({
      text: '已移除失败：连不上',
      ok: false,
    });
  });
});
