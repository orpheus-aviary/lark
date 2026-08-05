import type { PlayerStatusData } from '@lark/shared';
import { describe, expect, it, vi } from 'vitest';
import { createReporter } from './reporter.js';

function snapshot(currentTime: number): PlayerStatusData {
  return {
    current_song: null,
    is_playing: true,
    current_time: currentTime,
    duration: 100,
    play_mode: 'sequential',
    playlist_id: 'all',
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A promise the test completes by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('single flight', () => {
  it('collapses everything queued behind an in-flight report into one send', async () => {
    const sent: number[] = [];
    const first = deferred();
    const reporter = createReporter({
      send: (state) => {
        sent.push(state.current_time);
        return first.promise;
      },
    });

    reporter.push(snapshot(1));
    reporter.push(snapshot(2));
    reporter.push(snapshot(3));
    expect(sent).toEqual([1]);

    first.resolve();
    await flush();
    // 2 was overwritten by 3 while the first request was in the air: the
    // daemon's mirror must never move backwards.
    expect(sent).toEqual([1, 3]);
  });

  it('releases the channel when a report rejects', async () => {
    const sent: number[] = [];
    const reporter = createReporter({
      send: (state) => {
        sent.push(state.current_time);
        return Promise.reject(new Error('offline'));
      },
      warn: vi.fn(),
    });

    reporter.push(snapshot(1));
    await flush();
    reporter.push(snapshot(2));
    await flush();

    expect(sent).toEqual([1, 2]);
  });

  it('passes a timeout signal so one stuck request cannot wedge the channel', async () => {
    const signals: AbortSignal[] = [];
    const controller = new AbortController();
    const reporter = createReporter({
      send: (_state, signal) => {
        signals.push(signal);
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('timed out')));
        });
      },
      timeoutSignal: () => controller.signal,
      warn: vi.fn(),
    });

    reporter.push(snapshot(1));
    await flush();
    reporter.push(snapshot(2));
    expect(signals).toHaveLength(1); // still in flight

    controller.abort();
    await flush();
    expect(signals).toHaveLength(2); // the dirty snapshot went out afterwards
  });

  it('sends nothing after dispose', async () => {
    const send = vi.fn(() => Promise.resolve());
    const reporter = createReporter({ send });
    reporter.dispose();
    reporter.push(snapshot(1));
    await flush();
    expect(send).not.toHaveBeenCalled();
  });
});
