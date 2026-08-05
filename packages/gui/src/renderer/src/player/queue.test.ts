import { describe, expect, it, vi } from 'vitest';
import { DISCARDED, createOperationQueue } from './queue.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('serialisation', () => {
  it('runs operations one at a time, in order', async () => {
    const queue = createOperationQueue();
    const events: string[] = [];
    const slow = async (name: string): Promise<void> => {
      events.push(`${name}:start`);
      await tick();
      events.push(`${name}:end`);
    };

    const first = queue.run(() => slow('a'));
    const second = queue.run(() => slow('b'));
    await Promise.all([first, second]);

    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('keeps running after an operation throws', async () => {
    const queue = createOperationQueue();
    const failed = queue.run(() => Promise.reject(new Error('boom')));
    const after = queue.run(() => 'ok');

    await expect(failed).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
  });
});

describe('generations', () => {
  it('tells a continuation that a later operation has started', async () => {
    const queue = createOperationQueue();
    let staleCtxIsCurrent: (() => boolean) | null = null;

    await queue.run((ctx) => {
      staleCtxIsCurrent = ctx.isCurrent;
      expect(ctx.isCurrent()).toBe(true);
    });
    await queue.run(() => undefined);

    expect(staleCtxIsCurrent).not.toBeNull();
    expect((staleCtxIsCurrent as unknown as () => boolean)()).toBe(false);
  });
});

describe('deadlines', () => {
  it('discards a command whose deadline passed while it waited', async () => {
    let clock = 1000;
    const queue = createOperationQueue({ now: () => clock });
    const executed: string[] = [];

    // The first operation holds the slot long enough to blow the deadline.
    const first = queue.run(async () => {
      executed.push('first');
      await tick();
      clock = 5000;
    });
    const second = queue.run(
      () => {
        executed.push('second');
      },
      { deadlineAt: 2000 },
    );

    await first;
    await expect(second).resolves.toBe(DISCARDED);
    expect(executed).toEqual(['first']);
  });

  it('runs a command that is still inside its deadline', async () => {
    const now = vi.fn(() => 1000);
    const queue = createOperationQueue({ now });
    await expect(queue.run(() => 'ran', { deadlineAt: 3000 })).resolves.toBe('ran');
  });
});
