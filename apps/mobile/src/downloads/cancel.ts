// Cancelling, and the three different things it can mean (N4d, §1.3).
//
// `engine.cancel` has three outcomes on purpose (`portable/download/engine.ts`):
// a queued or early-running task is CANCELLED, one past the commit point is
// REFUSED — it is seconds from finishing and nothing here can hurry it — and a
// terminal one is a NO-OP the caller can safely retry. A screen that collapsed
// those into "done" would tell someone their download stopped when it did not.
//
// TWO CALLERS, ONE SCOPE, TWO ERROR POLICIES (decision d).
//
// What they share, and must: WHICH tasks "everything" means, and in what
// order. `isActive` is queued + running, lyrics included, because a lyrics
// fetch is network work too; the order is queued first, because cancelling a
// running task frees the worker and a queued task promoted into that gap would
// be a task started after the sweep began.
//
// What they do NOT share is what to do with an error nobody predicted. The
// system revoking the quota (`foreground.handleTimeout`) is not a conversation
// — an unexplained failure there propagates, loudly, because nothing else will
// ever mention it. A person tapping 取消 is a conversation, and the honest
// reply to "that task is not in the ring any anymore" is "it already finished",
// not a crash.

import { type DownloadTaskData, taskTitle } from '@lark/shared';

/** Queued and running both, lyrics included (decision h, then decision d). */
export const isActive = (task: DownloadTaskData): boolean =>
  task.state === 'queued' || task.state === 'running';

/**
 * Everything a sweep should touch, in the order it should touch it.
 *
 * Queued before running: see the header. `handleTimeout` walks the engine's own
 * snapshot through this; the screen walks the hub's.
 */
export function activeInSweepOrder(tasks: readonly DownloadTaskData[]): DownloadTaskData[] {
  const active = tasks.filter(isActive);
  return [
    ...active.filter((task) => task.state === 'queued'),
    ...active.filter((task) => task.state === 'running'),
  ];
}

/** The three answers, as the engine gives them. */
export type CancelOutcome = 'cancelled' | 'refused' | 'already-done';

export interface CancelResult {
  taskId: string;
  /** What to call it in a sentence — the title, or the input it came from. */
  title: string;
  outcome: CancelOutcome;
}

/** The one method this file needs from an engine. */
export interface CancellableEngine {
  cancel(taskId: string): unknown;
}

const codeOf = (err: unknown): string =>
  err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : String(err);

/**
 * One cancel, answered.
 *
 * `TASK_NOT_FOUND` reads as `already-done` rather than as an error: the id came
 * off a list this screen rendered, so the only way it is gone is that it aged
 * out of the engine's ring — which happens to terminal tasks. Anything else
 * throws, because a screen that swallowed an unknown failure would leave a
 * running download looking cancelled.
 */
export function cancelOne(engine: CancellableEngine, task: DownloadTaskData): CancelResult {
  const title = taskTitle(task);
  if (!isActive(task)) return { taskId: task.id, title, outcome: 'already-done' };
  try {
    engine.cancel(task.id);
    return { taskId: task.id, title, outcome: 'cancelled' };
  } catch (err) {
    const code = codeOf(err);
    if (code === 'TASK_NOT_CANCELLABLE') return { taskId: task.id, title, outcome: 'refused' };
    if (code === 'TASK_NOT_FOUND') return { taskId: task.id, title, outcome: 'already-done' };
    throw err;
  }
}

/**
 * 全部取消 — which is not one result but N of them (§1.3).
 *
 * Every task gets its own answer and the sweep always finishes: one task past
 * the commit point must not make the others report failure, and must not be
 * reported as stopped either.
 */
export function cancelActive(
  engine: CancellableEngine,
  tasks: readonly DownloadTaskData[],
): CancelResult[] {
  return activeInSweepOrder(tasks).map((task) => cancelOne(engine, task));
}

/**
 * What to say afterwards, in one line.
 *
 * Counts rather than names: a sweep over eight tasks that listed each one would
 * be a paragraph on a phone. The refusals are the exception and get their own
 * clause, because they are the only outcome where something is still running.
 */
export function summariseCancels(results: readonly CancelResult[]): string {
  if (results.length === 0) return '没有进行中的任务';
  const parts: string[] = [];
  const count = (outcome: CancelOutcome) => results.filter((r) => r.outcome === outcome).length;

  const cancelled = count('cancelled');
  const refused = count('refused');
  const done = count('already-done');

  if (cancelled > 0) parts.push(`已取消 ${cancelled} 个`);
  if (refused > 0) parts.push(`${refused} 个已经在落盘，停不下来`);
  if (done > 0) parts.push(`${done} 个已经结束`);
  return parts.join(' · ');
}

/** One task's answer, for the row that was tapped. */
export function describeCancel(result: CancelResult): string {
  switch (result.outcome) {
    case 'cancelled':
      return `已取消《${result.title}》`;
    case 'refused':
      return `《${result.title}》已经在落盘，停不下来了`;
    case 'already-done':
      return `《${result.title}》已经结束了`;
  }
}
