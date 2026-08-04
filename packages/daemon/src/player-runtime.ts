// In-memory player mirror + command/ack correlation (R11 / M2-11).
//
// The renderer owns playback: the daemon never persists player state (a
// restart legitimately forgets it) and never decides what plays. It keeps the
// last report so `GET /player/status` can answer, and it parks a command's
// HTTP response until the GUI acks it — which is why the pending map has FOUR
// settle paths, not one: ack, timeout, the active GUI vanishing, and shutdown.
// Every settle removes the entry first, so a late ack finds nothing and is a
// no-op rather than a double-resolve.

import type { PlayerStatusData } from '@lark/shared';

export type CommandOutcome =
  /** GUI executed the command. */
  | { kind: 'ok' }
  /** GUI answered `ok:false` — its message is forwarded (502). */
  | { kind: 'gui-error'; message: string }
  /** No ack within `ackTimeoutMs` (504). */
  | { kind: 'timeout' }
  /** No active GUI, or the one we sent to went away / failed to accept (409). */
  | { kind: 'offline' }
  /** The daemon is tearing down (503). */
  | { kind: 'shutting-down' };

interface PendingCommand {
  readonly guiId: string;
  readonly settle: (outcome: CommandOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class PlayerRuntime {
  /** Last full status the GUI reported, or null if none since boot. */
  lastReport: PlayerStatusData | null = null;
  /** `Date.now()` of that report. */
  reportedAt: number | null = null;

  private readonly pending = new Map<string, PendingCommand>();

  /**
   * Park a command until its ack arrives, `timeoutMs` elapses, or another
   * settle path fires. `guiId` records which GUI connection it was sent to so
   * a disconnect can fail exactly that connection's commands.
   */
  track(requestId: string, guiId: string, timeoutMs: number): Promise<CommandOutcome> {
    return new Promise<CommandOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, { kind: 'timeout' }), timeoutMs);
      // An in-flight HTTP request already holds the event loop open; unref'ing
      // keeps a forgotten timer from being the last thing standing at exit.
      timer.unref?.();
      this.pending.set(requestId, { guiId, settle: resolve, timer });
    });
  }

  /** Settle one pending command. Returns false when it is unknown / already settled. */
  settle(requestId: string, outcome: CommandOutcome): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.settle(outcome);
    return true;
  }

  /** `POST /player/ack`. Unknown / late request ids answer false (caller 200s anyway). */
  ack(requestId: string, ok: boolean, message?: string): boolean {
    return this.settle(
      requestId,
      ok ? { kind: 'ok' } : { kind: 'gui-error', message: message ?? 'GUI reported a failure' },
    );
  }

  /** Settle every command sent to `guiId` — its connection just dropped. */
  failFor(guiId: string, outcome: CommandOutcome): number {
    let n = 0;
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.guiId !== guiId) continue;
      if (this.settle(requestId, outcome)) n++;
    }
    return n;
  }

  /** Settle everything — teardown runs this before closing the server. */
  failAll(outcome: CommandOutcome): number {
    let n = 0;
    for (const requestId of [...this.pending.keys()]) {
      if (this.settle(requestId, outcome)) n++;
    }
    return n;
  }

  /** Number of commands awaiting an ack. */
  get pendingCount(): number {
    return this.pending.size;
  }
}
