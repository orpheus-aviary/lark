import type { LarkEvent } from '@lark/shared';

type Subscriber = (event: LarkEvent) => void;

/**
 * In-process pub/sub for the daemon → GUI reverse channel (owl parity).
 *
 * Deliberately tiny: one `Set` of callbacks. SSE lifecycle (socket open/close,
 * keepalive, preClose flush, backpressure) lives in `routes/events.ts`, and
 * the single-consumer player channel lives in `gui-channel.ts` — this class
 * only fans out broadcasts.
 *
 * Dispatch iterates a snapshot so a handler that unsubscribes mid-dispatch
 * can't mutate the set underneath us, and handler exceptions are swallowed so
 * one wedged subscriber can't break fan-out to the others.
 */
export class EventsBus {
  private readonly subscribers = new Set<Subscriber>();

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Returns the subscriber count AFTER dispatch. */
  emit(event: LarkEvent): number {
    for (const fn of [...this.subscribers]) {
      try {
        fn(event);
      } catch {
        // isolate one bad subscriber — the writer logs upstream
      }
    }
    return this.subscribers.size;
  }

  close(): void {
    this.subscribers.clear();
  }

  size(): number {
    return this.subscribers.size;
  }
}
