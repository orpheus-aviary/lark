// What a selection can be done to, and what to say afterwards (N4i-2, §2.3).
//
// The actions themselves are one line of `LibraryService` each. What is here
// is the part that is easy to get wrong and impossible to see on a phone: a
// batch that stops at its first failure, and a sentence that says "已删除 3 首"
// when one of them is still there.
//
// TWO SHAPES, AND THE DIFFERENCE IS core's, NOT A CHOICE MADE HERE:
//
//   `addPlaylistSongs` takes an ARRAY — one call, one transaction, and
//   membership it already has is not added twice. So "加入歌单" is atomic and
//   its only outcome is a number.
//
//   `deleteSong` takes ONE id and drains the file journal each time, so ten
//   songs are ten awaits. There is no batch delete in core and this file does
//   not invent one: what it does is keep going after a failure and count both
//   sides, because "删了 7 首，3 首没删成" is the honest sentence and stopping
//   at the first one leaves a selection nobody can reason about.
//
// Pure over injected callbacks: no service, no React, no toast. The wording is
// on trial as much as the loop is — it is what a person is left with.

export interface BatchOutcome {
  done: number;
  /** What went wrong, one message per failed id, in order. */
  failures: readonly string[];
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Run one action over every id, in order, and never stop early.
 *
 * `onProgress` is called after each one because the screen has to move: ten
 * deletes are ten file-journal drains, and a button that goes quiet for four
 * seconds reads as a crash.
 */
export async function runBatch(
  ids: readonly string[],
  act: (id: string) => Promise<void> | void,
  onProgress?: (done: number, total: number) => void,
): Promise<BatchOutcome> {
  const failures: string[] = [];
  let done = 0;
  for (const id of ids) {
    try {
      await act(id);
      done += 1;
    } catch (err) {
      failures.push(message(err));
    }
    onProgress?.(done + failures.length, ids.length);
  }
  return { done, failures };
}

/**
 * One line for what just happened.
 *
 * The failures are COUNTED and one of them is quoted: a phone toast holding
 * nine reasons is a toast nobody reads, and holding none is a batch that
 * failed silently. The first reason is almost always all of them (a full disk,
 * a busy song), and the count says how far it spread.
 */
export function describeBatch(verb: string, outcome: BatchOutcome): string {
  const failed = outcome.failures.length;
  if (failed === 0) return `已${verb} ${outcome.done} 首`;
  if (outcome.done === 0) return `一首都没能${verb}：${outcome.failures[0]}`;
  return `已${verb} ${outcome.done} 首，${failed} 首没能${verb}：${outcome.failures[0]}`;
}
