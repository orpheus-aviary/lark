// Trying a failed download again, without being asked (0.1.1 ⑧).
//
// WHICH failures and HOW MANY times are `downloads/retry.ts`'s, where they can
// be checked. What is here is the part that needs the process: watching the
// hub, following one chain of attempts, and taking the superseded row out of
// the record.
//
// 🔴 THE CHAIN IS FOLLOWED BY TASK ID, and every attempt is counted against
// the same chain. A retry produces a NEW task, so `attempts` is re-keyed onto
// it as the request goes out — key this by anything derived from the request
// and a value that normalises differently on the way round starts a fresh
// count, which is a loop rather than "one extra try".
//
// ONE ROW PER CHAIN. The retry removes the record of the attempt it is
// replacing, so a download occupies one line in 下载记录 and that line says
// how it ended — rather than three identical failures for a limit of three.
//
// LYRICS ARE NEVER RETRIED HERE. The engine spawns one after every download,
// nobody asked for it on its own, and hammering three lyrics providers for
// every failed fetch is a cost with no consumer. Its record row keeps a 重下.
//
// SUBSCRIBED AT THE ASSEMBLY ROOT, like the history: a download started from
// 歌曲 can fail with nobody on the download page, and that is the failure this
// exists for.

import { planRetry, recordOf } from '@lark/core/portable';
import type { DownloadTaskData } from '@lark/shared';
import type { BootResult } from '../boot/sequence';
import { downloadHistoryOnce } from './history-runtime';
import { downloads } from './hub';
import { engineLogger } from './log';
import { replay, supersededRecord } from './replay';
import { replayDepsOnce } from './replay-runtime';
import { readRetryLimit, shouldRetry } from './retry';

/**
 * A backstop, not a policy (see the header's note on chains).
 *
 * The count that bounds a chain is re-keyed onto the new task as the retry
 * goes out, and that write happens in a microtask while a failure needs the
 * worker — so it lands first. "So it lands first" is a reading of two
 * schedulers, though, and the failure mode if it is ever wrong is a request
 * storm: each attempt would start a fresh count and retry forever. This is the
 * number that cannot happen past. It is deliberately far above any real
 * session — reaching it means something is wrong, which is why it is logged.
 */
const MAX_AUTOMATIC_RETRIES = 50;

let bound = false;

export function bindAutoRetry(boot: BootResult): void {
  if (bound) return;
  bound = true;

  const history = downloadHistoryOnce(boot);
  const deps = replayDepsOnce(boot);
  /** Failures already judged. A hub tick is not an event; the ring is a list. */
  const judged = new Set<string>();
  /** Attempts made so far, by the task the NEXT one would be. */
  const attempts = new Map<string, number>();
  let issued = 0;

  const consider = (task: DownloadTaskData): void => {
    if (task.state !== 'failed' || judged.has(task.id)) return;
    judged.add(task.id);
    if (task.kind === 'lyrics') return;

    // The first failure is attempt 1; a chain carries its own count forward.
    const made = attempts.get(task.id) ?? 1;
    const limit = readRetryLimit(boot.deviceSettings, engineLogger);
    if (!shouldRetry(task.error_code, made, limit)) return;

    const record = recordOf(task);
    if (record === null) return;

    if (issued >= MAX_AUTOMATIC_RETRIES) {
      engineLogger.error(
        { task: task.id, issued },
        'automatic download retries hit the per-process backstop — not retrying any more',
      );
      return;
    }
    issued += 1;

    void replay(deps, planRetry(record)).then((outcome) => {
      if (!supersededRecord(outcome)) {
        // Could not get it back on the queue. The record stays exactly as it
        // was, which is the honest thing to leave behind: a failed row with a
        // 重下 on it.
        engineLogger.warn(
          { task: task.id, code: task.error_code, said: outcome.message },
          'a download could not be retried automatically',
        );
        return;
      }
      attempts.set(outcome.taskId, made + 1);
      // The attempt just superseded is not a second line in the record.
      history.remove(task.id);
    });
  };

  downloads.subscribe(() => {
    for (const task of downloads.getState().tasks) consider(task);
  });
  for (const task of downloads.getState().tasks) consider(task);
}
