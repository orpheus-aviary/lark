// Criterion 18 in full, and the half of criterion 17 that is not Android's to
// answer (subplan §3).
//
// The device still owns the other half — whether the system ACCEPTS a start
// from the gesture and refuses one from the background is Android speaking,
// and no fake can say it. What is checkable here is everything that follows
// from the answer: which tasks get cancelled and in what order, when the
// service is allowed to stop, and that a refused start still downloads the
// song.
//
// COUNTER-TESTS, for the next person who changes this file (§4). Each one was
// run against this file before it was called done — green proves nothing, a
// broken implementation going red does:
//
//   - cancel only `running` on a timeout → "cancels the queued ones too" fails
//   - stop the service before cancelling → "cancels before it stops" fails
//   - set the phase after the cancels instead of before → "does not let the
//     emptied queue call itself idle" fails
//   - swallow every cancel failure → "propagates a cancel failure that is not
//     the commit point" fails
//   - drop the grace and stop at zero → "waits out the grace" fails
//   - move the start from the gesture to the enqueue → "starts at the gesture,
//     before anything is enqueued" fails
//   - drop the de-duplication → "says nothing twice" fails
//   - drop the throttle → "says nothing more than once a second" fails
//   - drop the start confirmation → "a start that resolves and brings up
//     nothing is still degraded" fails
//   - drop its generation guard → "a disposed controller does not get the last
//     word" fails
//   - drop its phase guard → "says nothing about a download that never
//     started" fails
//
// The last two are the reason those are two tests and not one: the first
// version asserted both at once and stayed green with no de-duplication in the
// file, because the throttle was dropping the duplicates on its own.

import type { DownloadTaskData, DownloadTaskInput, TaskState } from '@lark/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ForegroundController,
  type ForegroundStatus,
  createForegroundController,
} from './foreground';

function task(
  id: string,
  state: TaskState,
  over: Partial<DownloadTaskData> = {},
): DownloadTaskData {
  const input: DownloadTaskInput = { type: 'url', url: `https://b23.tv/${id}` };
  return {
    id,
    kind: 'download',
    state,
    stage: state === 'running' ? 'downloading' : null,
    revision: 1,
    input,
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
    title: null,
    artist: null,
    ...over,
  };
}

interface Timer {
  at: number;
  fn: () => void;
}

interface Harness {
  controller: ForegroundController;
  /** `start:…` / `update:…` / `stop`, in the order they were called. */
  log: string[];
  cancelled: string[];
  status(): ForegroundStatus;
  setTasks(tasks: readonly DownloadTaskData[]): void;
  advance(ms: number): Promise<void>;
  /** Make the next `start` reject, the way the system refusing OUT LOUD does. */
  refuseStart(code: string): void;
  /** Make the next `start` resolve and bring up nothing — the silent refusal. */
  refuseStartSilently(): void;
  /** Make `cancel` throw for one task, the way the commit point does. */
  refuseCancel(taskId: string, code: string): void;
  /** Leave the screen (`AppState` stops saying `active`). */
  background(): void;
}

function harness(): Harness {
  const log: string[] = [];
  const cancelled: string[] = [];
  const listeners = new Set<() => void>();
  const timers = new Set<Timer>();
  const refusedCancels = new Map<string, string>();
  let tasks: readonly DownloadTaskData[] = [];
  let published: ForegroundStatus = { phase: 'idle', reason: null };
  let startError: Error | null = null;
  let running = false;
  let silentRefusal = false;
  let now = 10_000;
  /** `AppState.currentState === 'active'`, as the controller asks it. */
  let appActive = true;

  const controller = createForegroundController({
    service: {
      start(title, body) {
        log.push(`start:${title}|${body}`);
        if (startError !== null) {
          const err = startError;
          startError = null;
          return Promise.reject(err);
        }
        // The service comes up unless the test says it silently does not —
        // which is what vivo's Android 15 does from the background (N4c-3).
        running = !silentRefusal;
        silentRefusal = false;
        return Promise.resolve();
      },
      update(title, body) {
        log.push(`update:${title}|${body}`);
        return Promise.resolve();
      },
      stop() {
        log.push('stop');
        running = false;
        return Promise.resolve();
      },
      isRunning: () => Promise.resolve(running),
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => ({ tasks }),
    engine: {
      snapshot: () => ({ tasks }),
      cancel(taskId) {
        const code = refusedCancels.get(taskId);
        if (code !== undefined) {
          const err: Error & { code?: string } = new Error(`${taskId} is past the point`);
          err.code = code;
          throw err;
        }
        cancelled.push(taskId);
        tasks = tasks.map((entry) =>
          entry.id === taskId ? { ...entry, state: 'cancelled' as const } : entry,
        );
        for (const listener of listeners) listener();
      },
    },
    publish: (status) => {
      published = status;
    },
    now: () => now,
    delay(ms, fn) {
      const timer: Timer = { at: now + ms, fn };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    appActive: () => appActive,
  });

  return {
    controller,
    log,
    cancelled,
    status: () => published,
    /**
     * Leave the screen. Timers keep working in this harness — the point of the
     * case below is that the CODE must not need them to, and a fake that froze
     * its own clock would be testing the fake.
     */
    background() {
      appActive = false;
    },
    setTasks(next) {
      tasks = next;
      for (const listener of listeners) listener();
    },
    async advance(ms) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(timer);
        timer.fn();
      }
      // The start confirmation is async: firing its timer only queues the read.
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    },
    refuseStart(code) {
      const err: Error & { code?: string } = new Error('the system would not start it');
      err.code = code;
      startError = err;
    },
    refuseStartSilently() {
      silentRefusal = true;
    },
    refuseCancel(taskId, code) {
      refusedCancels.set(taskId, code);
    },
  };
}

let h: Harness;

beforeEach(() => {
  h = harness();
});

describe('arming', () => {
  it('starts at the gesture, before anything is enqueued', async () => {
    await h.controller.arm();

    expect(h.log).toEqual(['start:正在下载|准备中…']);
    expect(h.status().phase).toBe('arming');
  });

  it('becomes running with the first task, and names it', async () => {
    await h.controller.arm();
    h.setTasks([task('a', 'running', { title: '青花瓷' })]);

    expect(h.status().phase).toBe('running');
    expect(h.log).toEqual(['start:正在下载|准备中…', 'update:正在下载 1 首|青花瓷']);
  });

  it('retreats when the preflight enqueues nothing', async () => {
    await h.controller.arm();
    // Nothing arrived, and nothing is going to: the link was refused, or the
    // user's playlist turned out to be empty.
    h.controller.settle();

    expect(h.log).toEqual(['start:正在下载|准备中…', 'stop']);
    expect(h.status().phase).toBe('idle');
  });

  it('does not retreat while the preflight is still running', async () => {
    await h.controller.arm();
    // A hub event with nothing active — another task finished, a batch
    // changed. `arming` has to sit through it.
    h.setTasks([task('old', 'succeeded')]);

    expect(h.log).toEqual(['start:正在下载|准备中…']);
    expect(h.status().phase).toBe('arming');
  });

  it('does not re-enter the foreground state for a second download', async () => {
    await h.controller.arm();
    h.setTasks([task('a', 'running', { title: '青花瓷' })]);
    await h.advance(2_000);
    await h.controller.arm();

    expect(h.log.filter((line) => line.startsWith('start:'))).toHaveLength(1);
    expect(h.status().phase).toBe('running');
  });
});

describe('stopping', () => {
  it('waits out the grace, then stops', async () => {
    await h.controller.arm();
    h.setTasks([task('a', 'running', { title: '青花瓷' })]);
    h.setTasks([task('a', 'succeeded', { title: '青花瓷' })]);

    await h.advance(1_999);
    expect(h.log).not.toContain('stop');
    expect(h.status().phase).toBe('running');

    await h.advance(1);
    expect(h.log).toContain('stop');
    expect(h.status().phase).toBe('idle');
  });

  it('a task inside the grace cancels the stop', async () => {
    await h.controller.arm();
    h.setTasks([task('a', 'running', { title: '青花瓷' })]);
    h.setTasks([task('a', 'succeeded', { title: '青花瓷' })]);
    await h.advance(1_000);
    h.setTasks([task('a', 'succeeded'), task('b', 'queued', { title: '本草纲目' })]);
    await h.advance(5_000);

    expect(h.log).not.toContain('stop');
    expect(h.status().phase).toBe('running');
  });

  it('a gesture inside the grace cancels the stop', async () => {
    await h.controller.arm();
    h.setTasks([task('a', 'running', { title: '青花瓷' })]);
    h.setTasks([task('a', 'succeeded', { title: '青花瓷' })]);
    await h.advance(1_000);
    // The tap happens here; its preflight takes longer than the grace had
    // left, and the enqueue lands well after the stop would have.
    await h.controller.arm();
    await h.advance(5_000);
    h.setTasks([task('a', 'succeeded'), task('b', 'queued', { title: '本草纲目' })]);
    h.controller.settle();

    expect(h.log).not.toContain('stop');
    expect(h.status().phase).toBe('running');
  });

  // 🔴 REPORTED from the device, 2026-08-24: after a batch finished with the app
  // in the background, the notification sat on 「正在下载 1 首」 and the service
  // stayed up. The queue emptying is a JS callback and it ran; what did not run
  // was the timer it scheduled — measured three times in this app (N0b-4a, N3f,
  // N4c-3), and the stop was the one step in a download's whole life that
  // depended on one.
  it('stops at once when the app is away, because the grace has nothing to protect', async () => {
    await h.controller.arm();
    h.setTasks([task('a', 'running', { title: '青花瓷' })]);
    h.background();
    h.setTasks([task('a', 'succeeded', { title: '青花瓷' })]);
    // No `advance`: the fix is that this needs no clock at all. A second
    // download cannot be started from a screen nobody is looking at, so there
    // is no churn to smooth out — and the dataSync quota is a daily budget.
    await Promise.resolve();

    expect(h.log).toContain('stop');
    expect(h.status().phase).toBe('idle');
  });

  it('stops when a gesture inside the grace enqueues nothing after all', async () => {
    await h.controller.arm();
    h.setTasks([task('a', 'running', { title: '青花瓷' })]);
    h.setTasks([task('a', 'succeeded', { title: '青花瓷' })]);
    await h.advance(1_000);
    await h.controller.arm();
    h.controller.settle();
    await h.advance(2_000);

    expect(h.log).toContain('stop');
    expect(h.status().phase).toBe('idle');
  });
});

describe('the notification', () => {
  it('counts queued, running and lyrics tasks alike', async () => {
    await h.controller.arm();
    h.setTasks([
      task('a', 'running', { title: '青花瓷' }),
      task('b', 'queued', { title: '本草纲目' }),
      task('c', 'queued', { kind: 'lyrics', title: '青花瓷' }),
      task('d', 'succeeded', { title: '菊花台' }),
    ]);

    expect(h.log).toContain('update:正在下载 3 首|青花瓷');
  });

  it('says nothing twice', async () => {
    await h.controller.arm();
    const running = task('a', 'running', { title: '青花瓷' });
    h.setTasks([running]);
    // Progress ticks. THE CLOCK IS MOVED PAST THE THROTTLE between them on
    // purpose: with it left where it was, the throttle alone would drop these
    // and this would pass with no de-duplication in the file at all.
    await h.advance(5_000);
    h.setTasks([{ ...running, received_bytes: 1_000 }]);
    await h.advance(5_000);
    h.setTasks([{ ...running, received_bytes: 2_000 }]);

    expect(h.log.filter((line) => line.startsWith('update:'))).toHaveLength(1);
  });

  it('says nothing more than once a second', async () => {
    await h.controller.arm();
    const running = task('a', 'running', { title: '青花瓷' });
    h.setTasks([running]);

    // A real change, but too soon: dropped rather than queued, because the
    // next event recomputes the current text anyway.
    await h.advance(500);
    h.setTasks([running, task('b', 'queued', { title: '本草纲目' })]);
    expect(h.log.filter((line) => line.startsWith('update:'))).toHaveLength(1);

    await h.advance(500);
    h.setTasks([running, task('b', 'queued'), task('c', 'queued')]);
    expect(h.log).toContain('update:正在下载 3 首|青花瓷');
  });

  it('falls back to what the user typed before a task has a name', async () => {
    await h.controller.arm();
    h.setTasks([task('a', 'queued')]);

    expect(h.log).toContain('update:正在下载 1 首|https://b23.tv/a');
  });
});

describe('degraded', () => {
  it('downloads anyway when the system refuses the service', async () => {
    h.refuseStart('ERR_LARK_FGS_NOT_ALLOWED');
    await h.controller.arm();

    expect(h.status()).toEqual({ phase: 'degraded', reason: 'ERR_LARK_FGS_NOT_ALLOWED' });

    h.setTasks([task('a', 'running', { title: '青花瓷' })]);
    h.controller.settle();

    // No cancel, and nothing said to a service that is not there.
    expect(h.cancelled).toEqual([]);
    expect(h.log.filter((line) => line.startsWith('update:'))).toEqual([]);
    expect(h.status().phase).toBe('degraded');
  });

  it('keeps the code of a failure that is not the system refusing', async () => {
    h.refuseStart('ERR_UNAVAILABLE');
    await h.controller.arm();

    expect(h.status()).toEqual({ phase: 'degraded', reason: 'ERR_UNAVAILABLE' });
  });

  it('a start that resolves and brings up nothing is still degraded', async () => {
    // MEASURED on the device (N4c-3): vivo's Android 15 refuses a background
    // `startForegroundService` SILENTLY. No exception reaches JS and no service
    // exists — the one failure the first version of this file could not see.
    h.refuseStartSilently();
    await h.controller.arm();
    expect(h.status().phase).toBe('arming');

    await h.advance(2_000);

    expect(h.status()).toEqual({ phase: 'degraded', reason: 'ERR_LARK_FGS_NEVER_STARTED' });
  });

  it('downgrades even after the phase has moved on to running', async () => {
    h.refuseStartSilently();
    await h.controller.arm();
    h.setTasks([task('a', 'running', { title: '青花瓷' })]);
    expect(h.status().phase).toBe('running');

    await h.advance(2_000);

    expect(h.status().phase).toBe('degraded');
  });

  it('leaves a service that really did come up alone', async () => {
    await h.controller.arm();
    await h.advance(2_000);

    expect(h.status().phase).toBe('arming');
  });

  it('says nothing about a download that never started', async () => {
    h.refuseStartSilently();
    await h.controller.arm();
    // The preflight enqueued nothing, so the machine is already back at idle
    // when the confirmation lands. A warning about a download that does not
    // exist is a warning nobody can act on.
    h.controller.settle();
    await h.advance(2_000);

    expect(h.status().phase).toBe('idle');
  });

  it('a disposed controller does not get the last word', async () => {
    h.refuseStartSilently();
    await h.controller.arm();
    // Acceptance builds several controllers over one hub, and each scenario
    // disposes its own. A confirmation still in flight belongs to a controller
    // nobody reads — publishing from it would write over whatever the CURRENT
    // one has to say.
    h.controller.dispose();
    await h.advance(2_000);

    expect(h.status().phase).toBe('arming');
  });

  it('still stops a service it believes never started', async () => {
    h.refuseStart('ERR_LARK_FGS_NOT_ALLOWED');
    await h.controller.arm();
    h.setTasks([task('a', 'running')]);
    h.setTasks([task('a', 'succeeded')]);
    await h.advance(2_000);

    expect(h.log).toContain('stop');
    expect(h.status().phase).toBe('idle');
  });
});

describe('the quota expiring', () => {
  it('cancels the queued ones too, then stops', async () => {
    await h.controller.arm();
    h.setTasks([
      task('a', 'running', { title: '青花瓷' }),
      task('b', 'queued', { title: '本草纲目' }),
      task('c', 'queued', { title: '菊花台' }),
      task('d', 'succeeded', { title: '发如雪' }),
    ]);

    await h.controller.handleTimeout();

    // Queued first: cancelling a running task frees the worker, and a queued
    // one promoted in that gap would be work started after the system said
    // stop. A terminal task is not cancelled at all.
    expect(h.cancelled).toEqual(['b', 'c', 'a']);
    expect(h.status()).toEqual({ phase: 'paused-by-system', reason: null });
  });

  it('cancels before it stops', async () => {
    await h.controller.arm();
    h.setTasks([task('a', 'running'), task('b', 'queued')]);
    h.log.length = 0;

    await h.controller.handleTimeout();

    // The other order leaves a window with the service gone and the transfer
    // still going — exactly the thing that was just forbidden.
    expect(h.log).toEqual(['stop']);
    expect(h.cancelled).toEqual(['b', 'a']);
  });

  it('finishes the sweep when one task is past the point of no return', async () => {
    await h.controller.arm();
    h.setTasks([
      task('a', 'running', { stage: 'saving' }),
      task('b', 'running'),
      task('c', 'queued'),
    ]);
    h.refuseCancel('a', 'TASK_NOT_CANCELLABLE');

    await h.controller.handleTimeout();

    expect(h.cancelled).toEqual(['c', 'b']);
    expect(h.log).toContain('stop');
  });

  it('propagates a cancel failure that is not the commit point', async () => {
    await h.controller.arm();
    h.setTasks([task('a', 'running')]);
    h.refuseCancel('a', 'TASK_NOT_FOUND');

    await expect(h.controller.handleTimeout()).rejects.toThrow('past the point');
  });

  it('does not let the emptied queue call itself idle', async () => {
    await h.controller.arm();
    h.setTasks([task('a', 'running'), task('b', 'queued')]);

    await h.controller.handleTimeout();
    // The cancels emptied the hub, and a phase still reading `running` would
    // have scheduled a stop that lands here and overwrites the truth.
    await h.advance(10_000);

    expect(h.status().phase).toBe('paused-by-system');
  });

  it('a fresh gesture is allowed to try again', async () => {
    await h.controller.arm();
    h.setTasks([task('a', 'running')]);
    await h.controller.handleTimeout();
    h.log.length = 0;

    // The frozen diagram draws no automatic edge out of `paused-by-system`,
    // and this is not one: the user tapping download again is a new decision,
    // and the system will refuse it if the quota really is gone — which lands
    // in `degraded`, where it belongs.
    await h.controller.arm();

    expect(h.log).toEqual(['start:正在下载|准备中…']);
    expect(h.status().phase).toBe('arming');
  });
});
