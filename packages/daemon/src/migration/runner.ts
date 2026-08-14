// The mp3 → m4a pass, as the daemon runs it (0.3.0 T3, master plan §3.2).
//
// Core owns every decision this makes: what to scan, what class an object is,
// what happens to one file, and when a failure is the machine's fault rather
// than the song's. What lives here is the part core cannot have — the order,
// the cancellation, and the one thing the whole phase machine hangs on:
//
//   the pass ends, the pending flag is cleared, and only THEN does the daemon
//   build the runtime that serves the library.
//
// Three properties are worth stating because they are easy to lose:
//
//   The pass starts AFTER `listen()` (§3.2-3). A migration nobody can watch is
//   indistinguishable from a hung daemon.
//   A round always re-scans first. Between two rounds a file op may have been
//   discarded, a permission fixed, or an mp3 restored by hand — the scan is how
//   any of that becomes work.
//   "Nothing moved" ends the pass, rather than "nothing is left". Rows that are
//   `blocked` are re-judged every round (附表 A.4b), so a loop that stopped only
//   when the ledger was empty would spin forever on a directory nobody can
//   write to.

import {
  type ConverterContext,
  type LedgerRow,
  type ResolvedMediaTools,
  type StepResult,
  classifyMigrationError,
  clearAudioMigrationPending,
  countLedgerByStatus,
  listActionableLedgerRows,
  listTerminalLedgerRows,
  mp3ObjectKeys,
  preflightAudioMigration,
  scanAudioMigration,
  stepObject,
} from '@lark/core';
import type { AudioMigrationState } from '@lark/shared';
import { canRedownload } from '../cache.js';
import type { BaseContext } from '../context.js';
import type { Mutex } from './runtime.js';

/**
 * How many scan/step rounds one pass will run.
 *
 * A round that settles nothing already ends the pass, so this only bounds the
 * pathological case where each round creates work for the next (a file being
 * restored under the daemon as fast as it is moved aside).
 */
const MAX_ROUNDS = 5;

export interface MigrationRunnerOptions {
  /**
   * The pass is over and the library is single-format. Called at most once per
   * successful finish; activation's own guard decides what happens if a retry
   * and the boot pass both get here.
   */
  onFinished: () => Promise<void>;
  /**
   * Serializes the pass against the file-op routes (T3b). Optional so a test
   * can drive the runner alone; the daemon always passes the runtime's.
   */
  mutex?: Mutex;
  /** Test seam: report free bytes instead of asking the filesystem. */
  freeBytes?: () => Promise<number>;
  nowMs?: () => number;
}

export class MigrationRunner {
  readonly #ctx: BaseContext;
  readonly #options: MigrationRunnerOptions;
  readonly #controller = new AbortController();
  /**
   * Teardown or `stop()`, as one signal.
   *
   * Composed once, in the constructor, rather than per use: every `AbortSignal.any`
   * subscribes to both sources, and a pass over a large library asks for this
   * once per object.
   */
  readonly #signal: AbortSignal;
  #state: AudioMigrationState = 'running';
  /** Why the pass stopped, when it stopped for the machine's sake. */
  #reason: string | null = null;
  #running: Promise<void> | null = null;
  #stopped = false;
  /** Whether `onFinished` has already been told. */
  #announced = false;

  constructor(ctx: BaseContext, options: MigrationRunnerOptions) {
    this.#ctx = ctx;
    this.#options = options;
    this.#signal = AbortSignal.any([ctx.shutdownSignal, this.#controller.signal]);
  }

  state(): AudioMigrationState {
    return this.#state;
  }

  /** Why the pass is stuck. Absolute paths are possible — never goes on `/status`. */
  reason(): string | null {
    return this.#reason;
  }

  /**
   * Run a pass, or join the one already running.
   *
   * Single-flight rather than queued: two overlapping passes would step the
   * same rows, and the second one's view of the disk would be a lie the moment
   * the first one moved a file.
   */
  run(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    const mutex = this.#options.mutex;
    this.#running ??= (mutex === undefined ? this.#pass() : mutex.run(() => this.#pass())).finally(
      () => {
        this.#running = null;
      },
    );
    return this.#running;
  }

  /** Stop the pass and wait for ffmpeg to go away. Idempotent. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#controller.abort(new Error('daemon shutting down'));
    await this.#running?.catch(() => {
      /* a pass that died on the way out has already logged */
    });
  }

  async #pass(): Promise<void> {
    const logger = this.#ctx.logger;
    this.#state = 'running';
    this.#reason = null;

    let tools: ResolvedMediaTools;
    try {
      tools = await this.#ctx.mediaTools.acquire();
      // Before the first file, and before the ledger is even consulted: a pass
      // that cannot convert must touch nothing at all (§3.2-5).
      const preflight = await preflightAudioMigration({
        sqlite: this.#ctx.sqlite,
        tools,
        signal: this.#signal,
        ...(this.#options.freeBytes === undefined ? {} : { freeBytes: this.#options.freeBytes }),
      });
      if (!preflight.ok) return this.#blockOnEnvironment(preflight.reason);
    } catch (err) {
      // Same classifier the converter uses, for the same reason: a teardown
      // arriving while the capability probe runs looks exactly like a probe
      // that failed, and only the signal tells them apart (附表 A.1).
      if (classifyMigrationError(err, 'convert', this.#signal) === 'abort') return;
      return this.#blockOnEnvironment(err instanceof Error ? err.message : String(err));
    }

    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (this.#signal.aborted) return;
      const scan = scanAudioMigration(this.#ctx.sqlite, this.#now());
      logger.info({ round, ...scan }, 'audio migration scanned');

      const settled = await this.#round(tools);
      if (settled === null) return; // aborted, or the machine is the problem

      if (this.#isComplete()) return await this.#finish();
      if (settled === 0) break;
    }

    this.#state = 'needs_attention';
    logger.warn(
      { ...countLedgerByStatus(this.#ctx.sqlite), mp3_left: mp3ObjectKeys().length },
      'audio migration cannot continue on its own',
    );
  }

  /**
   * One sweep over everything the pass may act on.
   *
   * Returns how many objects reached a terminal state — `null` when the sweep
   * was cut short, which is the only outcome the caller must not treat as
   * progress. A row that comes back `blocked` counts as zero on purpose: it is
   * exactly the row that would otherwise make the round loop forever.
   */
  async #round(tools: ResolvedMediaTools): Promise<number | null> {
    const converter = this.#converterContext(tools);
    let settled = 0;

    for (const row of this.#actionableRows()) {
      if (this.#signal.aborted) return null;
      const result: StepResult = await stepObject(converter, row);
      if (result.kind === 'aborted') return null;
      if (result.kind === 'environment') {
        this.#blockOnEnvironment(result.message);
        return null;
      }
      if (result.kind === 'settled') settled++;
      if (result.kind === 'blocked') {
        this.#ctx.logger.warn(
          { object_key: row.object_key, message: result.message },
          'audio migration object needs a person',
        );
      }
    }
    return settled;
  }

  /**
   * Rows to step, in one list: what the pass owes, plus finished objects whose
   * mp3 came back. The second half is not bookkeeping — until a stray mp3 is
   * moved aside, "no mp3 under songs/" cannot become true and the migration
   * can never finish (§3.2-13).
   */
  #actionableRows(): LedgerRow[] {
    const holdsMp3 = new Set(mp3ObjectKeys());
    const stray = listTerminalLedgerRows(this.#ctx.sqlite).filter((row) =>
      holdsMp3.has(row.object_key),
    );
    return [...listActionableLedgerRows(this.#ctx.sqlite), ...stray];
  }

  #converterContext(tools: ResolvedMediaTools): ConverterContext {
    return {
      sqlite: this.#ctx.sqlite,
      tools,
      // The cache eviction's probe, not a copy of it (R26 / §4-h): "can we get
      // this back" has one implementation, and it lives behind the daemon's
      // one bilibili client.
      canRedownload: (sourceKey, signal) => canRedownload(this.#ctx, sourceKey, signal),
      signal: this.#signal,
      logger: this.#ctx.logger,
      ...(this.#options.nowMs === undefined ? {} : { nowMs: this.#options.nowMs }),
    };
  }

  /** §3.2-13, both halves: the ledger is settled AND the served tree is clean. */
  #isComplete(): boolean {
    const counts = countLedgerByStatus(this.#ctx.sqlite);
    const unfinished =
      (counts.pending ?? 0) +
      (counts.converting ?? 0) +
      (counts.discarding ?? 0) +
      (counts.backing_up ?? 0) +
      (counts.blocked ?? 0) +
      (counts.blocked_file_op ?? 0);
    return unfinished === 0 && mp3ObjectKeys().length === 0;
  }

  async #finish(): Promise<void> {
    clearAudioMigrationPending(this.#ctx.sqlite);
    this.#state = 'finished';
    // Once. A pass may legitimately run again after the migration is over — the
    // retry endpoint is still reachable, and a restored mp3 is still worth
    // reconciling — but there is one activation, and announcing a second would
    // put its guard in the wrong place (this runner knows; the caller should
    // not have to).
    if (this.#announced) return;
    this.#announced = true;
    this.#ctx.logger.info(countLedgerByStatus(this.#ctx.sqlite), 'audio migration finished');
    await this.#options.onFinished();
  }

  /**
   * The machine is the problem: stop, keep the flag, delete nothing.
   *
   * The reason is logged rather than raised — a pass that throws would take the
   * daemon down, and the daemon is the only thing that can tell the user what
   * to fix (§3.2-5's retry entry point).
   */
  #blockOnEnvironment(reason: string): void {
    this.#state = 'blocked_environment';
    this.#reason = reason;
    this.#ctx.logger.error({ reason }, 'audio migration stopped: the machine cannot continue');
  }

  #now(): number {
    return (this.#options.nowMs ?? Date.now)();
  }
}
