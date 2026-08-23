// `--wait`: following a download to its end (M6-11).
//
// Polling, not SSE. A one-shot command that has to hold a long-lived event
// stream open — and reconnect it — to answer "is it done yet?" is a lot of
// machinery for a question `GET /download/tasks` answers directly; the CLI
// deliberately does not subscribe (§1).
//
// The interesting case is the one that has no answer: terminal tasks age out
// of a 100-entry ring, so a task that finished a long time ago is simply GONE.
// That is `TASK_STATE_UNKNOWN` — "it is not running and I cannot tell you how
// it went" — and never "it failed", which would be a guess. Batches survive
// their tasks (each item keeps its own terminal snapshot), so batch waiting
// only loses the answer once the 20-batch ring rolls over.
//
// From 0.3.0 the transfer reports bytes (§3.5), and the two audiences want
// opposite things from it: a terminal wants one line that keeps changing, a
// log wants a line per milestone and nothing between. Hence two renderers over
// the same snapshot, with `tty` picking.

import type { DownloadBatchData, DownloadTaskData } from '@lark/shared';
import { STAGE_LABELS } from '@lark/shared';
import type { CommandContext } from '../context.js';
import { CliError } from './errors.js';

const DEFAULT_POLL_MS = 500;

export interface WaitDeps {
  /** Injected by tests so a poll loop costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** Injected with `sleep`: the non-TTY progress floor is a real interval. */
  now?: () => number;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** Non-TTY milestones (§4-d): every tenth, or — size unknown — every 5MiB. */
const STEP_FRACTION = 0.1;
const STEP_BYTES = 5 * 1024 * 1024;
const STEP_MS = 2000;

function napper(deps: WaitDeps): () => Promise<void> {
  const ms = deps.pollMs ?? DEFAULT_POLL_MS;
  const sleep = deps.sleep ?? ((wait: number) => new Promise((r) => setTimeout(r, wait)));
  return () => sleep(ms);
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * The stage, or the one thing a task with no stage is doing.
 *
 * `STAGE_LABELS` is `@lark/shared`'s (N4d, decision a) — the same table the
 * GUI and the phone read, after this file had carried its own copy since M6.
 * The `null` case stays here: it is this renderer's, not the enum's.
 */
function stageText(task: DownloadTaskData): string {
  return task.stage === null ? '排队中' : STAGE_LABELS[task.stage];
}

/** `下载音频 42%` / `下载音频 3.4MB`, or just the stage when nothing moved. */
function describe(task: DownloadTaskData): string {
  const stage = stageText(task);
  if (task.stage !== 'downloading' || task.received_bytes === 0) return stage;
  return task.total_bytes === null
    ? `${stage} ${mib(task.received_bytes)}`
    : `${stage} ${Math.floor((task.received_bytes / task.total_bytes) * 100)}%`;
}

/**
 * Progress on stderr, in whichever of the two shapes fits the destination.
 *
 * Silent under `--json`: stdout is reserved for the one envelope, and a run
 * that is being parsed has no use for a running commentary.
 */
class Progress {
  #announced = '';
  #steppedBytes = 0;
  #steppedAt = 0;
  readonly #ctx: CommandContext;
  readonly #now: () => number;

  constructor(ctx: CommandContext, deps: WaitDeps) {
    this.#ctx = ctx;
    this.#now = deps.now ?? Date.now;
  }

  report(task: DownloadTaskData): void {
    if (this.#ctx.flags.json) return;
    const text = describe(task);
    if (this.#ctx.streams.tty) {
      // Overwriting a line costs one escape sequence, so the only thing worth
      // suppressing is a repeat of the same text.
      if (text !== this.#announced) this.#ctx.streams.errLine(`… ${text}`);
      this.#announced = text;
      return;
    }
    if (this.#milestone(task)) this.#ctx.streams.err(`… ${text}`);
  }

  /** End the live line, so what prints next does not land on top of it. */
  finish(): void {
    if (!this.#ctx.flags.json && this.#ctx.streams.tty && this.#announced !== '') {
      this.#ctx.streams.errLine('');
    }
  }

  /**
   * Is this snapshot worth a LINE? A stage change always is; inside the
   * transfer, only every tenth of it — or, with no size to divide by, every
   * few megabytes or seconds, so a slow download still says something.
   */
  #milestone(task: DownloadTaskData): boolean {
    const text = describe(task);
    if (!this.#announced.startsWith(stageText(task))) {
      this.#mark(task, text);
      return true;
    }
    if (task.stage !== 'downloading' || task.received_bytes === 0) return false;

    const delta = task.received_bytes - this.#steppedBytes;
    const stepped =
      task.total_bytes === null
        ? delta >= STEP_BYTES || this.#now() - this.#steppedAt >= STEP_MS
        : delta >= task.total_bytes * STEP_FRACTION;
    if (!stepped) return false;
    this.#mark(task, text);
    return true;
  }

  #mark(task: DownloadTaskData, text: string): void {
    this.#announced = text;
    this.#steppedBytes = task.received_bytes;
    this.#steppedAt = this.#now();
  }
}

/**
 * Poll until the task reaches a terminal state, and return its final snapshot.
 *
 * Ctrl-C during the wait ends the CLI with the shell's usual 130 — the task
 * itself keeps running in the daemon, which is the right outcome: waiting is
 * watching, not owning.
 */
export async function waitForTask(
  ctx: CommandContext,
  taskId: string,
  deps: WaitDeps = {},
): Promise<DownloadTaskData> {
  const nap = napper(deps);
  const progress = new Progress(ctx, deps);

  for (;;) {
    const envelope = await ctx.backend.downloadTasks();
    const task = envelope.data?.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) {
      progress.finish();
      throw new CliError(
        'TASK_STATE_UNKNOWN',
        `任务 ${taskId} 已经不在 daemon 的任务列表里，无法确认它的结果（终态任务会滚出队列）。`,
        { task_id: taskId },
      );
    }
    if (TERMINAL.has(task.state)) {
      progress.finish();
      return task;
    }

    progress.report(task);
    await nap();
  }
}

/** Poll until every item of the batch carries a terminal snapshot. */
export async function waitForBatch(
  ctx: CommandContext,
  batchId: string,
  deps: WaitDeps = {},
): Promise<DownloadBatchData> {
  const nap = napper(deps);
  let announced = -1;

  for (;;) {
    const envelope = await ctx.backend.downloadTasks();
    const batch = envelope.data?.batches.find((candidate) => candidate.id === batchId);
    if (batch === undefined) {
      throw new CliError(
        'TASK_STATE_UNKNOWN',
        `批次 ${batchId} 已经不在 daemon 的批次列表里，无法确认结果。`,
        { batch_id: batchId },
      );
    }

    const done = batch.items.filter((item) => item.final !== null).length;
    // `total` is what was requested; `items` is what got registered. A batch is
    // finished when every registered item has landed AND none is still missing.
    if (done === batch.total && batch.items.length === batch.total) return batch;

    if (!ctx.flags.json && done !== announced) {
      announced = done;
      ctx.streams.err(`… 已完成 ${done}/${batch.total}`);
    }
    await nap();
  }
}
