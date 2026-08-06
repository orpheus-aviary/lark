// The quit sequence (M5-3), electron-free so both attachment modes can be
// tested without an app.
//
// M4 had two half-sequences: `before-quit` only prevented the default when a
// daemon was OWNED, and anything else that needed to happen on the way out
// (now: writing the window size) had nowhere to run — in the reused case the
// process was already gone, and in the owned case the daemon it would talk to
// was being stopped.
//
// So there is one machine, and it always preventDefault()s the first quit:
//
//   1. flush the window size — while the daemon is still up,
//   2. wait for an in-flight `start()`, so a spawn racing the quit cannot
//      leave an orphan daemon behind (M4-2 ④),
//   3. stop the owned daemon (a no-op when it was reused),
//   4. mark done and quit for real — the second `before-quit` passes through.

export interface QuitSteps {
  /** Write the last window size. Never throws in practice; guarded anyway. */
  flushWindowSize: () => Promise<void>;
  /** Resolve once any in-flight daemon start has settled. */
  settleDaemonStart: () => Promise<void>;
  /** Stop the daemon this process owns; a no-op for a reused one. */
  stopOwnedDaemon: () => Promise<void>;
  /** The real quit — called once every step is done. */
  quit: () => void;
  log?: (msg: string) => void;
}

export class QuitCoordinator {
  readonly #steps: QuitSteps;
  #started = false;
  #done = false;

  constructor(steps: QuitSteps) {
    this.#steps = steps;
  }

  /** True once the sequence has run: the next `before-quit` must go through. */
  get finished(): boolean {
    return this.#done;
  }

  /**
   * Handle a `before-quit`. Returns whether the caller should preventDefault
   * — false only after everything has already been done.
   */
  handleBeforeQuit(): boolean {
    if (this.#done) return false;
    if (!this.#started) {
      this.#started = true;
      void this.#run();
    }
    return true; // a repeat quit while the sequence runs is also prevented
  }

  async #run(): Promise<void> {
    for (const [what, step] of [
      ['flush the window size', this.#steps.flushWindowSize],
      ['wait for the daemon start', this.#steps.settleDaemonStart],
      ['stop the owned daemon', this.#steps.stopOwnedDaemon],
    ] as const) {
      try {
        await step();
      } catch (err) {
        // Nothing here may block the exit: a failed step is a log line.
        this.#steps.log?.(`[quit] could not ${what}: ${String(err)}`);
      }
    }
    this.#done = true;
    this.#steps.quit();
  }
}
