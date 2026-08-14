// What exists while the library is being converted (0.3.0 T3b, §3.2-3/§3.2-10).
//
// Two things, and one rule between them.
//
// The PASS converts. The JOURNAL EXECUTOR is how a user gets a stuck sync file
// op out of the way — an op that gave up mid-flight owns a song directory, the
// scan marks that object `blocked_file_op`, and the migration can never finish
// until somebody retries or discards it. Without that door there is no way out
// of the boot screen except editing the database.
//
// The rule: they never run at once. Both walk into `songs/<id>/` and move
// files; the pass would be judging a directory the executor is halfway through.
// One mutex serializes them, and a resolved file op kicks the pass so the
// unblocked object is picked up without waiting for a restart.
//
// This is also the daemon's ONLY file-effect runtime during the migration —
// the normal one belongs to the runtime that does not exist yet, and it shares
// the download engine's claim registry, which does not exist either.

import { FileEffectRuntime } from '@lark/core';
import type { AudioMigrationState } from '@lark/shared';
import type { BaseContext } from '../context.js';
import type { MigrationHandle } from '../lifecycle.js';
import { MigrationRunner, type MigrationRunnerOptions } from './runner.js';

/**
 * Serialize async sections. Same shape as the sync runtime's lifecycle chain:
 * the tail is a promise nobody rejects, so one failed section does not poison
 * the ones behind it.
 */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class MigrationRuntime implements MigrationHandle {
  readonly runner: MigrationRunner;
  readonly fileOps: FileEffectRuntime;
  readonly #ctx: BaseContext;
  readonly #mutex = new Mutex();

  constructor(ctx: BaseContext, options: MigrationRunnerOptions) {
    this.#ctx = ctx;
    this.runner = new MigrationRunner(ctx, { ...options, mutex: this.#mutex });
    // A claim registry of its own, like boot's drain: the download engine that
    // owns the shared one does not exist during the migration, and nothing
    // else in this process is touching a song directory except the pass —
    // which the mutex, not a claim, keeps apart from this.
    this.fileOps = new FileEffectRuntime({
      sqlite: ctx.sqlite,
      logger: ctx.logger,
      onQuarantine: (songId) =>
        ctx.eventsBus.emit({ type: 'sync:file_quarantined', song_id: songId }),
    });
  }

  /**
   * Run something that touches song directories, never beside the pass.
   *
   * The file-op routes and the backup clear go through here; the pass takes
   * the same mutex from the inside.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.#mutex.run(fn);
  }

  /** Run a pass, or join the one running (boot's first pass, and the retry). */
  run(): Promise<void> {
    return this.runner.run();
  }

  state(): AudioMigrationState {
    return this.runner.state();
  }

  reason(): string | null {
    return this.runner.reason();
  }

  stop(): Promise<void> {
    return this.runner.stop();
  }

  /**
   * A file op was retried or discarded: the object it owned may be free now.
   *
   * Kicked rather than awaited — the route that resolved the op answers about
   * the OP, and the pass that follows can take minutes. The pass re-scans on
   * entry, which is where a released directory becomes work again.
   */
  continueAfterFileOp(): void {
    void this.runner.run().catch((err: unknown) => {
      this.#ctx.logger.error({ err }, 'audio migration pass failed after a file op');
    });
  }
}
