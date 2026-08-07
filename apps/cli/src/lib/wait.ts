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

import type { DownloadBatchData, DownloadStage, DownloadTaskData } from '@lark/shared';
import type { CommandContext } from '../context.js';
import { CliError } from './errors.js';

const DEFAULT_POLL_MS = 500;

export interface WaitDeps {
  /** Injected by tests so a poll loop costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

const STAGE_TEXT: Record<DownloadStage, string> = {
  analyzing: '分析输入',
  searching: '搜索候选',
  resolving: '解析地址',
  downloading: '下载音频',
  converting: '转码',
  saving: '保存',
  lyrics: '抓歌词',
};

function napper(deps: WaitDeps): () => Promise<void> {
  const ms = deps.pollMs ?? DEFAULT_POLL_MS;
  const sleep = deps.sleep ?? ((wait: number) => new Promise((r) => setTimeout(r, wait)));
  return () => sleep(ms);
}

/**
 * Poll until the task reaches a terminal state, and return its final snapshot.
 *
 * Progress goes to STDERR, and only in human mode: stdout is reserved for the
 * one envelope, and a `--json` run that is being parsed has no use for a
 * running commentary. Ctrl-C during the wait ends the CLI with the shell's
 * usual 130 — the task itself keeps running in the daemon, which is the right
 * outcome: waiting is watching, not owning.
 */
export async function waitForTask(
  ctx: CommandContext,
  taskId: string,
  deps: WaitDeps = {},
): Promise<DownloadTaskData> {
  const nap = napper(deps);
  let announced = '';

  for (;;) {
    const envelope = await ctx.backend.downloadTasks();
    const task = envelope.data?.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) {
      throw new CliError(
        'TASK_STATE_UNKNOWN',
        `任务 ${taskId} 已经不在 daemon 的任务列表里，无法确认它的结果（终态任务会滚出队列）。`,
        { task_id: taskId },
      );
    }
    if (TERMINAL.has(task.state)) return task;

    if (!ctx.flags.json) {
      const line = task.stage === null ? '排队中' : STAGE_TEXT[task.stage];
      if (line !== announced) {
        announced = line;
        ctx.streams.err(`… ${line}`);
      }
    }
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
