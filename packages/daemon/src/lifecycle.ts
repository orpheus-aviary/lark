// How far the daemon has come up (0.3.0 T3, master plan §3.2-3).
//
// Before 0.3.0 there was nothing to model: boot either finished or the process
// died, and by the time the socket was listening every runtime existed. The
// one-time mp3 → m4a migration breaks that — the daemon has to be REACHABLE
// while it converts, so a GUI can show progress and a stuck file op can be
// cleared, but it must not serve the library in the meantime (§3.2-2).
//
// So there are four phases and one rule about them:
//
//   pending    → the migration owns the process. Only the whitelist answers.
//   activating → the migration is over and the normal runtime is being built.
//                Business routes STILL refuse: a request answered here would
//                find half a daemon.
//   normal     → everything.
//   fatal      → activation failed; the process is on its way out.
//
// The gate reads `phase` out of memory on every request, never the database
// flag: the flag is cleared inside activation, and a per-request read of it
// would open business routes in the window before the runtime exists.

import type { AudioMigrationState, DaemonPhase } from '@lark/shared';

/**
 * The migration pass, as the rest of the daemon sees it.
 *
 * Kept as an interface here rather than importing the runner, so the phase
 * machine does not depend on the thing it is sequencing.
 */
export interface MigrationHandle {
  /** What the pass is doing right now — `/status`'s `state` word. */
  state(): AudioMigrationState;
  /** Stop the pass and wait for its ffmpeg child to go away. Idempotent. */
  stop(): Promise<void>;
}

export class DaemonLifecycle {
  #phase: DaemonPhase;
  #migration: MigrationHandle | null = null;
  #activationClaimed = false;

  /**
   * A library that owes the conversion starts `pending`; every other one is
   * `normal` before the socket is even bound, so a boot that has nothing to
   * migrate behaves exactly as it did in 0.2.
   */
  constructor(phase: 'pending' | 'normal') {
    this.#phase = phase;
  }

  get phase(): DaemonPhase {
    return this.#phase;
  }

  /**
   * The pass, or null when this boot never had one.
   *
   * It stays attached after activation on purpose: the ledger is the report,
   * and `finished` is a state the GUI shows on a daemon that is already
   * serving the library.
   */
  get migration(): MigrationHandle | null {
    return this.#migration;
  }

  attachMigration(handle: MigrationHandle): void {
    this.#migration = handle;
  }

  /**
   * Claim the one activation. Returns false when someone already has it — the
   * boot pass and a retry that finishes the migration can both arrive here, and
   * building the normal runtime twice would leave two download engines and two
   * sync runtimes over one database.
   *
   * A library that owed nothing is already `normal` and takes this path too:
   * its activation happens before the socket is bound, so there is no window to
   * describe and the phase does not move.
   */
  beginActivation(): boolean {
    if (this.#activationClaimed) return false;
    this.#activationClaimed = true;
    if (this.#phase === 'pending') this.#phase = 'activating';
    return true;
  }

  /** The runtime is installed and swapped in; open the business routes. */
  finishActivation(): void {
    this.#phase = 'normal';
  }

  /** Activation threw. The process is going away; nothing may be served. */
  fail(): void {
    this.#phase = 'fatal';
  }
}
