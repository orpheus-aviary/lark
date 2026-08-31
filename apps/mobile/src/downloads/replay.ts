// Running one of the download records again (0.1.1 ⑦⑨).
//
// `planRetry` in `history.ts` decides WHAT re-running a record means; this
// carries it out, and the only reason it is a module rather than four lines in
// the screen is the branch table below. A link goes back through the add
// page's own recogniser — one parser, one set of refusals — and a recogniser
// has five answers, three of which are not downloads at all. A screen that
// only handled the happy one would answer a tap with nothing, which is exactly
// what a person retries again, harder.
//
// EVERY DEPENDENCY IS INJECTED, so the table is decidable without a network:
// what a run of this DOES is one of four calls, and which one is the part that
// can be wrong.

import type { RetryPlan } from '@lark/core/portable';
import type { KeywordItem, Recognition, VideoItem } from './preflight';

/**
 * Each of the three enqueues hands back the TASK ID it produced.
 *
 * 🔴 That is what bounds the automatic retry (⑧). It counts attempts per
 * chain, and a chain is only followable if each attempt can name the task the
 * next one belongs to — key it by anything derived (the url, the input) and a
 * value that normalises differently on the way round resets the count, which
 * is not "one extra try" but a loop.
 */
export interface ReplayDeps {
  /** The add page's recogniser, already bound to a client. */
  recognise: (text: string) => Promise<Recognition>;
  /** The add page's submit, already bound to the engine and the naming mode. */
  submit: (item: VideoItem | KeywordItem, playlistIds: readonly string[]) => Promise<string>;
  redownload: (songId: string) => string;
  lyrics: (songId: string) => string;
}

/**
 * Whether it went back on the queue, and what to tell the person who tapped.
 *
 * `queued` is a separate field rather than something read out of the sentence:
 * 全部重试 has to count, and counting by comparing strings is how a wording
 * change silently turns "3 requeued" into "0".
 */
export interface ReplayOutcome {
  queued: boolean;
  message: string;
  /** The task this became, when it became one. See `ReplayDeps`. */
  taskId: string | null;
}

/**
 * Did this replay SUPERSEDE the record it came from?
 *
 * 🔴 ONE ROW PER CHAIN, and this is the one place that decides it. A record is
 * keyed by its task id, so a retry always adds a row; the old one has to go,
 * and only once the new task exists — a request that failed must leave a row
 * that can be pressed again.
 *
 * Extracted in 0.5.1 because the rule had two copies and the path a PERSON
 * uses had neither: `retry-runtime.ts` did it automatically, `DownloadPanel`
 * did it on the desktop, and tapping 重下 on the phone did not (用户
 * 2026-08-31). Three call sites, one sentence.
 *
 * A type guard rather than a boolean: the caller that follows the chain needs
 * the task id right after asking, and `taskId !== null` twice is two places
 * for the same fact to be checked differently.
 */
export function supersededRecord(
  outcome: ReplayOutcome,
): outcome is ReplayOutcome & { taskId: string } {
  return outcome.queued && outcome.taskId !== null;
}

export async function replay(deps: ReplayDeps, plan: RetryPlan): Promise<ReplayOutcome> {
  try {
    if (plan.kind === 'redownload') {
      return { queued: true, message: '已重新排队', taskId: deps.redownload(plan.songId) };
    }
    if (plan.kind === 'lyrics') {
      return { queued: true, message: '已重新去找歌词', taskId: deps.lyrics(plan.songId) };
    }
    const seen = await deps.recognise(plan.text);
    switch (seen.kind) {
      case 'video':
      case 'keyword':
        return {
          queued: true,
          message: '已重新排队',
          taskId: await deps.submit(seen.item, plan.playlistIds),
        };
      case 'list':
        // A list link never became a task in the first place — it expands into
        // a picker — so this is only reachable if the stored url changed
        // meaning. Say where the choice lives rather than guessing at it.
        return { queued: false, message: '这是收藏夹或合集，去「添加」页重新挑一次', taskId: null };
      case 'refused':
        // portable's own sentence, which already says what is wrong with it.
        return { queued: false, message: seen.message, taskId: null };
      case 'empty':
        return { queued: false, message: '这条记录里的链接已经认不出来了', taskId: null };
    }
  } catch (err) {
    return {
      queued: false,
      message: err instanceof Error ? err.message : '没能重新排队',
      taskId: null,
    };
  }
}

/**
 * One line for a 全部重试 (0.1.1 ⑨).
 *
 * The failures are COUNTED and one of them is quoted, the same shape
 * `library/batch.ts` settled on: a phone line holding nine reasons is a line
 * nobody reads, and holding none is a batch that failed silently.
 */
export function summariseReplays(outcomes: readonly ReplayOutcome[]): string {
  const queued = outcomes.filter((outcome) => outcome.queued).length;
  const refused = outcomes.filter((outcome) => !outcome.queued);
  const first = refused[0]?.message ?? '';
  if (refused.length === 0) return `已重新排队 ${queued} 条`;
  if (queued === 0) return `一条都没能重新排队：${first}`;
  return `已重新排队 ${queued} 条，${refused.length} 条没能排上：${first}`;
}
