// `POST /player/report` scheduling (M4-10). The daemon puts no limit on how
// often a GUI reports, so the discipline lives here:
//
//   - single-flight: while a report is in the air, a newer state only marks
//     the channel dirty. Two concurrent reports can otherwise land out of
//     order and leave the daemon mirroring a state the player already left;
//   - the in-flight flag is released in `finally` AND the request carries a
//     timeout, so one request that never settles cannot wedge the channel
//     for the rest of the session.

import type { PlayerStatusData } from '@lark/shared';

const DEFAULT_TIMEOUT_MS = 5000;

export interface Reporter {
  /** Report this state as soon as the channel is free. */
  push(snapshot: PlayerStatusData): void;
  dispose(): void;
}

export function createReporter(deps: {
  send: (snapshot: PlayerStatusData, signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
  warn?: (message: string) => void;
  /** Test seam; production passes nothing and gets AbortSignal.timeout. */
  timeoutSignal?: (ms: number) => AbortSignal;
}): Reporter {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  let inFlight = false;
  let pending: PlayerStatusData | null = null;
  let disposed = false;

  const flush = async (): Promise<void> => {
    if (inFlight || disposed || pending === null) return;
    const snapshot = pending;
    pending = null;
    inFlight = true;
    try {
      await deps.send(snapshot, timeoutSignal(timeoutMs));
    } catch (err) {
      deps.warn?.(`player report failed: ${String(err)}`);
    } finally {
      inFlight = false;
    }
    void flush(); // whatever piled up while this one was in the air
  };

  return {
    push(snapshot) {
      if (disposed) return;
      pending = snapshot;
      void flush();
    },
    dispose() {
      disposed = true;
      pending = null;
    },
  };
}
