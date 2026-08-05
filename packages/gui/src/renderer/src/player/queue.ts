// One serial queue for EVERY player operation — local clicks, keyboard
// shortcuts and remote `player:command` events alike (M4-10).
//
// `subscribeSse`'s `onEvent` does not await its handler, so two commands
// arriving back to back run concurrently by default: `pause` finishes while
// `play` is still awaiting `audio.play()`, and the older play then writes the
// final state. Serialising them makes the last INTENT win, which is what a
// user pressing two buttons expects.
//
// Two more rules ride along:
//   - a remote command whose deadline has passed is DISCARDED — not executed,
//     not acked. The daemon gave up at 3s and already answered 504; running it
//     afterwards would produce a state change nobody asked for any more.
//   - an operation that has started is never interrupted, but every one of its
//     continuations carries its generation. Waking up to find a newer
//     operation has started means the result is stale: report it, never write
//     player state with it.

/** A remote command that missed its window: no execution, no ack. */
export const DISCARDED = Symbol('discarded');

export interface OperationContext {
  generation: number;
  /** False once a later operation has started (M4-10 supersede rule). */
  isCurrent(): boolean;
}

export interface OperationQueue {
  run<T>(
    task: (ctx: OperationContext) => Promise<T> | T,
    options?: { deadlineAt?: number },
  ): Promise<T | typeof DISCARDED>;
  /** Generation of the newest STARTED operation (0 before the first). */
  generation(): number;
}

export function createOperationQueue(deps: { now?: () => number } = {}): OperationQueue {
  const now = deps.now ?? (() => Date.now());
  let tail: Promise<unknown> = Promise.resolve();
  let generation = 0;

  return {
    generation: () => generation,

    run<T>(
      task: (ctx: OperationContext) => Promise<T> | T,
      options?: { deadlineAt?: number },
    ): Promise<T | typeof DISCARDED> {
      const result = tail.then(async (): Promise<T | typeof DISCARDED> => {
        // Checked at DEQUEUE, not at enqueue: the wait in front of us is
        // exactly what makes a command miss its deadline.
        if (options?.deadlineAt !== undefined && now() > options.deadlineAt) return DISCARDED;
        const mine = ++generation;
        return await task({ generation: mine, isCurrent: () => generation === mine });
      });
      // The chain must survive a failing operation, so the tail swallows.
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
