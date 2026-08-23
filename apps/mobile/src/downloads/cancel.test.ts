// Criterion 23's logic half (N4d): the three outcomes, and what a sweep over a
// mixed queue says afterwards.
//
// The device half — that a cancelled download leaves no `song.m4a` behind — is
// the landing protocol's and cannot be faked here. What CAN be settled here is
// the part that is a conversation: one task past the commit point must not make
// the other seven report failure, and must not be reported as stopped either.

import type { DownloadTaskData } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import {
  type CancellableEngine,
  activeInSweepOrder,
  cancelActive,
  cancelOne,
  describeCancel,
  isActive,
  summariseCancels,
} from './cancel';

function task(
  id: string,
  state: DownloadTaskData['state'],
  overrides: Partial<DownloadTaskData> = {},
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
    finished_at: null,
    error_code: null,
    error_message: null,
    result: null,
    received_bytes: 0,
    total_bytes: null,
    title: `曲 ${id}`,
    artist: null,
    ...overrides,
  };
}

/** An engine that answers the way the real one does, per task id. */
function engineWith(refusals: Record<string, string> = {}): CancellableEngine & {
  cancelled: string[];
} {
  const cancelled: string[] = [];
  return {
    cancelled,
    cancel(taskId: string) {
      const code = refusals[taskId];
      if (code !== undefined) {
        const err: Error & { code?: string } = new Error(`${taskId}: ${code}`);
        err.code = code;
        throw err;
      }
      cancelled.push(taskId);
    },
  };
}

describe('what "everything" means', () => {
  it('is queued and running, lyrics included', () => {
    expect(isActive(task('a', 'queued'))).toBe(true);
    expect(isActive(task('b', 'running'))).toBe(true);
    expect(isActive(task('c', 'running', { kind: 'lyrics' }))).toBe(true);
  });

  it('is not the terminal states', () => {
    for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(isActive(task('x', state))).toBe(false);
    }
  });

  it('puts queued first, so nothing is promoted into a freed worker', () => {
    const order = activeInSweepOrder([
      task('r', 'running'),
      task('done', 'succeeded'),
      task('q1', 'queued'),
      task('q2', 'queued'),
    ]);
    expect(order.map((t) => t.id)).toEqual(['q1', 'q2', 'r']);
  });
});

describe('one cancel, three answers', () => {
  it('a queued or early-running task is cancelled', () => {
    const engine = engineWith();
    expect(cancelOne(engine, task('a', 'queued')).outcome).toBe('cancelled');
    expect(cancelOne(engine, task('b', 'running')).outcome).toBe('cancelled');
    expect(engine.cancelled).toEqual(['a', 'b']);
  });

  it('one past the commit point is refused, and says so as itself', () => {
    const engine = engineWith({ a: 'TASK_NOT_CANCELLABLE' });
    const result = cancelOne(engine, task('a', 'running', { stage: 'saving' }));
    expect(result.outcome).toBe('refused');
    expect(describeCancel(result)).toBe('《曲 a》已经在落盘，停不下来了');
  });

  it('a terminal task is a no-op, and never reaches the engine', () => {
    const engine = engineWith();
    expect(cancelOne(engine, task('a', 'succeeded')).outcome).toBe('already-done');
    expect(engine.cancelled).toEqual([]);
  });

  it('a task that aged out of the ring reads as already done, not as an error', () => {
    // The id came off a list this screen rendered; the only way it is gone is
    // that it went terminal and the ring rolled over it.
    const engine = engineWith({ a: 'TASK_NOT_FOUND' });
    expect(cancelOne(engine, task('a', 'running')).outcome).toBe('already-done');
  });

  it('propagates a failure nothing here can explain', () => {
    const engine = engineWith({ a: 'SOMETHING_ELSE' });
    expect(() => cancelOne(engine, task('a', 'running'))).toThrow('SOMETHING_ELSE');
  });

  it('names a task by its input when it has no title yet', () => {
    const engine = engineWith();
    const result = cancelOne(engine, task('a', 'queued', { title: null }));
    expect(result.title).toBe('https://b23.tv/a');
  });
});

describe('全部取消 is N answers, not one', () => {
  it('finishes the sweep when one is past the commit point', () => {
    const engine = engineWith({ b: 'TASK_NOT_CANCELLABLE' });
    const results = cancelActive(engine, [
      task('b', 'running', { stage: 'saving' }),
      task('a', 'queued'),
      task('c', 'queued'),
    ]);
    expect(engine.cancelled).toEqual(['a', 'c']);
    expect(results.map((r) => r.outcome)).toEqual(['cancelled', 'cancelled', 'refused']);
  });

  it('skips what is already terminal', () => {
    const engine = engineWith();
    const results = cancelActive(engine, [task('a', 'succeeded'), task('b', 'running')]);
    expect(results.map((r) => r.taskId)).toEqual(['b']);
  });

  it('reports the refusal without calling the rest a failure', () => {
    const engine = engineWith({ b: 'TASK_NOT_CANCELLABLE' });
    const line = summariseCancels(
      cancelActive(engine, [
        task('a', 'queued'),
        task('c', 'queued'),
        task('b', 'running', { stage: 'saving' }),
      ]),
    );
    expect(line).toBe('已取消 2 个 · 1 个已经在落盘，停不下来');
  });

  it('says nothing happened when nothing was running', () => {
    expect(summariseCancels(cancelActive(engineWith(), [task('a', 'succeeded')]))).toBe(
      '没有进行中的任务',
    );
  });

  it('does not report a whole sweep as successful when it was not', () => {
    const engine = engineWith({ a: 'TASK_NOT_CANCELLABLE' });
    const line = summariseCancels(
      cancelActive(engine, [task('a', 'running', { stage: 'saving' })]),
    );
    expect(line).toBe('1 个已经在落盘，停不下来');
    expect(line).not.toContain('已取消');
  });
});
