// The desktop's automatic retry (2026-08-31 对齐, 判据 9/10).
//
// The engine and the history are fakes on purpose: what this module decides is
// WHETHER and HOW MANY TIMES, and both are decidable without downloading
// anything. The engine's own half — that a replay carries the task's target —
// is asserted where the target lives (`portable/download/engine.test.ts`).

import type { DownloadTaskData } from '@lark/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutoRetry } from './download-retry.js';

let nextId = 0;

function failed(overrides: Partial<DownloadTaskData> = {}): DownloadTaskData {
  nextId += 1;
  return {
    id: `task-${nextId}`,
    kind: 'download',
    state: 'failed',
    stage: null,
    revision: 1,
    input: { type: 'url', url: 'https://www.bilibili.com/video/BV1' },
    origin: { kind: 'video', url: 'https://www.bilibili.com/video/BV1' },
    song_id: null,
    playlist_ids: [],
    failed_playlist_ids: [],
    created_at: 0,
    started_at: 0,
    finished_at: 1,
    error_code: 'DOWNLOAD_TIMEOUT',
    error_message: 'timed out',
    result: null,
    received_bytes: 0,
    total_bytes: null,
    title: null,
    artist: null,
    ...overrides,
  };
}

/** The two collaborators, recorded. `enqueueRetry` hands back a fresh task. */
function harness(limit: number, options: { throws?: boolean } = {}) {
  const retried: string[] = [];
  const removed: string[] = [];
  const engine = {
    enqueueRetry: vi.fn((taskId: string) => {
      if (options.throws === true) throw new Error('download queue is full');
      retried.push(taskId);
      return failed({ state: 'queued', error_code: null });
    }),
  };
  const history = { remove: vi.fn((id: string) => removed.push(id)) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const auto = createAutoRetry({
    // Only the two methods this module touches; the rest of the surfaces are
    // not this decision's business.
    engine: engine as never,
    history: history as never,
    retryLimit: () => limit,
    logger: logger as never,
  });
  return { auto, engine, history, logger, retried, removed };
}

/** `queueMicrotask` is where the enqueue happens; let it run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  nextId = 0;
});

describe('what gets retried', () => {
  // 判据 9. Exactly ONE — a chain that started a fresh count on every attempt
  // would be a loop, and this is the assertion that tells the two apart.
  it('gives a timeout exactly one extra go at limit 1', async () => {
    const h = harness(1);

    h.auto.observe(failed());
    await settle();
    // 🔴 THE CHAIN. The retry is a NEW task, and when IT fails that is attempt
    // 2 of a limit of 1 — not a fresh chain starting over. Counting by the
    // request instead of by the task is what turns this into a loop, and this
    // second half is the only thing that tells the two apart.
    const retriedTask = h.engine.enqueueRetry.mock.results[0]?.value as DownloadTaskData;
    h.auto.observe(failed({ id: retriedTask.id }));
    await settle();

    expect(h.retried).toEqual(['task-1']);
  });

  it('does nothing at all at limit 0', async () => {
    const h = harness(0);

    h.auto.observe(failed());
    await settle();

    expect(h.engine.enqueueRetry).not.toHaveBeenCalled();
    expect(h.history.remove).not.toHaveBeenCalled();
  });

  it('retries a transport failure and refuses a dead link', async () => {
    const h = harness(1);

    h.auto.observe(failed({ error_code: 'BILIBILI_FAILED' }));
    h.auto.observe(failed({ error_code: 'SOURCE_GONE' }));
    await settle();

    expect(h.retried).toEqual(['task-1']);
  });

  // 🔴 The one that would defeat its own feature: the batch stopped BECAUSE
  // there is no room, and retrying by itself walks through the gate that
  // stopped it. Going past the limit is a person's decision (0.1.1 ⑤).
  it('never retries a cache-limit refusal', async () => {
    const h = harness(3);

    h.auto.observe(failed({ error_code: 'CACHE_LIMIT' }));
    await settle();

    expect(h.engine.enqueueRetry).not.toHaveBeenCalled();
  });

  it('ignores everything that is not a failure', async () => {
    const h = harness(1);

    h.auto.observe(failed({ state: 'succeeded', error_code: null }));
    h.auto.observe(failed({ state: 'running', error_code: null }));
    h.auto.observe(failed({ state: 'cancelled', error_code: null }));
    await settle();

    expect(h.engine.enqueueRetry).not.toHaveBeenCalled();
  });

  // `onStatus` fires more than once for one terminal task — without the seen
  // set, a single failure would be retried once per emission.
  it('judges one failure once, however often it is reported', async () => {
    const h = harness(3);
    const task = failed();

    h.auto.observe(task);
    h.auto.observe(task);
    h.auto.observe(task);
    await settle();

    expect(h.retried).toEqual(['task-1']);
  });
});

describe('the record', () => {
  // 判据 10. One row per chain: the row being replaced goes, and only once the
  // new task exists.
  it('removes the superseded row after the retry is queued', async () => {
    const h = harness(1);

    h.auto.observe(failed());
    await settle();

    expect(h.removed).toEqual(['task-1']);
    expect(h.engine.enqueueRetry).toHaveBeenCalledBefore(h.history.remove);
  });

  // A failed request must leave a row that can still be pressed. Removing the
  // row first and then failing to queue would delete the evidence.
  it('leaves the row alone when the queue refuses', async () => {
    const h = harness(1, { throws: true });

    h.auto.observe(failed());
    await settle();

    expect(h.removed).toEqual([]);
    expect(h.logger.warn).toHaveBeenCalled();
  });

  // `enqueueRetry` answers null for a lyrics task and for one it has forgotten.
  it('leaves the row alone when the engine declines', async () => {
    const h = harness(1);
    h.engine.enqueueRetry.mockReturnValue(null as never);

    h.auto.observe(failed());
    await settle();

    expect(h.removed).toEqual([]);
  });
});

describe('lyrics', () => {
  // Decided here as well as in the engine: this module never even asks, so a
  // failed lyrics fetch cannot consume a chain's budget.
  it('never asks the engine to replay one', async () => {
    const h = harness(3);

    h.auto.observe(failed({ kind: 'lyrics', input: { type: 'song', song_id: 's1' } }));
    await settle();

    expect(h.engine.enqueueRetry).not.toHaveBeenCalled();
  });
});
