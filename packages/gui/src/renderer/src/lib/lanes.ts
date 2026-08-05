// Lane-scoped supersede/abort primitive (M4-7).
//
// Refetches are grouped into LOGICAL LANES, and only a later request in the
// SAME lane supersedes (aborts + out-ranks) an earlier one. A global sequence
// or a single AbortController is forbidden by the plan: `hello` refreshes
// songs/playlists/config/tasks concurrently, and a global "last request wins"
// would mark every other lane's legitimate response stale.
//
// The frozen lane set lives with its consumers (`songs-query`,
// `playlist-members`, `playlists-list`, `config`, `download-tasks`,
// `lyrics:<songId>`); this module only provides the mechanism. Player-command
// preloads deliberately run OUTSIDE any lane — a list refresh must never
// abort a command's load (M4-10) — by calling the transport directly.

export interface Lane {
  /**
   * Start a new request in this lane: aborts the lane's previous in-flight
   * request and hands the runner a fresh signal. The returned promise
   * resolves `null` when THIS run was superseded (or aborted) before it
   * finished — the caller drops the result instead of committing stale data.
   */
  run<T>(runner: (signal: AbortSignal) => Promise<T>): Promise<T | null>;
  /** Abort whatever is in flight without starting anything new. */
  cancel(): void;
}

export function createLane(): Lane {
  let seq = 0;
  let controller: AbortController | null = null;

  return {
    async run<T>(runner: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
      controller?.abort();
      const mine = ++seq;
      const ctl = new AbortController();
      controller = ctl;
      try {
        const result = await runner(ctl.signal);
        return seq === mine ? result : null;
      } catch (err) {
        // A superseded run's abort is the expected outcome, not an error.
        if (ctl.signal.aborted || seq !== mine) return null;
        throw err;
      }
    },
    cancel(): void {
      controller?.abort();
      controller = null;
      seq++;
    },
  };
}
