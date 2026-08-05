import { describe, expect, it } from 'vitest';
import { createLane } from './lanes.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createLane', () => {
  it('a later run supersedes the earlier one in the SAME lane', async () => {
    const lane = createLane();
    const first = deferred<string>();
    const p1 = lane.run(async (signal) => {
      await first.promise;
      expect(signal.aborted).toBe(true); // superseded runs see their abort
      return 'stale';
    });
    const p2 = lane.run(async () => 'fresh');
    first.resolve('unblock');
    await expect(p2).resolves.toBe('fresh');
    await expect(p1).resolves.toBeNull(); // stale result is dropped, not thrown
  });

  it('independent lanes never supersede each other (M4-7)', async () => {
    const songs = createLane();
    const config = createLane();
    const slow = deferred<string>();
    const p1 = songs.run(async () => slow.promise);
    const p2 = config.run(async () => 'config-data');
    await expect(p2).resolves.toBe('config-data');
    slow.resolve('songs-data');
    await expect(p1).resolves.toBe('songs-data'); // still valid — different lane
  });

  it('an aborted run resolves null instead of throwing', async () => {
    const lane = createLane();
    const p = lane.run(
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
        }),
    );
    lane.cancel();
    await expect(p).resolves.toBeNull();
  });

  it('a real error from the CURRENT run propagates', async () => {
    const lane = createLane();
    await expect(
      lane.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
