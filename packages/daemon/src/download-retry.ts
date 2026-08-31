// Trying a failed download again, without being asked (2026-08-31 对齐).
//
// The desktop half of 0.1.1 ⑧, which shipped on the phone a version line ago
// and never got a second end. WHICH failures are worth another go and HOW MANY
// times is `@lark/core/portable`'s `download/retry.ts`, shared with the phone;
// what is here is the part that needs the process — following one chain of
// attempts and taking the superseded row out of the record.
//
// 🔴 IT LIVES IN THE DAEMON, NOT THE RENDERER. The GUI is closed for most of
// the day and the daemon keeps downloading; a retry that only ran while
// somebody had the window open would be missing in exactly the case this
// feature exists for. It also means the setting has to be config rather than
// localStorage — hence `[download] retry_limit` (`config-types.ts`).
//
// 🔴 THE CHAIN IS FOLLOWED BY TASK ID, and every attempt is counted against
// the same chain. A retry produces a NEW task, so `attempts` is re-keyed onto
// it as the retry goes out; key this by anything derived from the request — a
// url, an input string — and a value that normalises differently on the way
// round starts a fresh count, which is a loop rather than "one extra try".
//
// ONE ROW PER CHAIN. The retry removes the record of the attempt it replaces,
// so a download occupies one line in 下载记录 and that line says how it ended
// — rather than three identical failures for a limit of three. Same rule and
// same timing as the phone's `retry-runtime.ts` and the desktop's own 重下 in
// `DownloadPanel`: the old row goes ONLY once the new task exists.
//
// LYRICS ARE NEVER RETRIED HERE, and the engine enforces it rather than this
// file (`enqueueRetry` answers `null`): the engine spawns a lyrics task after
// every download, nobody asked for it on its own, and hammering three
// providers for every failed fetch is a cost with no consumer.

import type { DownloadEngine, DownloadHistory } from '@lark/core';
import { shouldRetry } from '@lark/core';
import type { DownloadTaskData } from '@lark/shared';
import type { Logger } from 'pino';

/**
 * A backstop, not a policy (see the header's note on chains).
 *
 * The count that bounds a chain is re-keyed onto the new task as the retry
 * goes out, and that write happens in a microtask while a failure needs the
 * engine's worker — so it lands first. "So it lands first" is a reading of one
 * scheduler, though, and the failure mode if it is ever wrong is a request
 * storm: each attempt would start a fresh count and retry forever. This is the
 * number that cannot happen past. It is deliberately far above any real
 * session — reaching it means something is wrong, which is why it is logged.
 */
export const MAX_AUTOMATIC_RETRIES = 50;

export interface AutoRetryDeps {
  engine: DownloadEngine;
  history: DownloadHistory;
  /** Read fresh, so a `PATCH /config` is picked up by the next failure. */
  retryLimit: () => number;
  logger: Logger;
}

export interface AutoRetry {
  /** Hand it every status the engine emits; it ignores everything but failures. */
  observe: (task: DownloadTaskData) => void;
}

export function createAutoRetry(deps: AutoRetryDeps): AutoRetry {
  /** Failures already judged — `onStatus` fires more than once per terminal task. */
  const judged = new Set<string>();
  /** Attempts made so far, by the task the NEXT one would be. */
  const attempts = new Map<string, number>();
  let issued = 0;

  return {
    observe(task) {
      if (task.state !== 'failed' || judged.has(task.id)) return;
      judged.add(task.id);
      if (task.kind === 'lyrics') return;

      // The first failure is attempt 1; a chain carries its own count forward.
      const made = attempts.get(task.id) ?? 1;
      if (!shouldRetry(task.error_code, made, deps.retryLimit())) return;

      if (issued >= MAX_AUTOMATIC_RETRIES) {
        deps.logger.error(
          { task: task.id, issued },
          'automatic download retries hit the process backstop — not retrying any more',
        );
        return;
      }
      issued += 1;

      // 🔴 NOT INLINE. This runs inside the engine's own `onStatus`, which is
      // called synchronously while the worker is between steps; enqueuing
      // there would mutate the task map and the queue underneath it. The phone
      // is separated from that by a store tick, and this is that gap, made on
      // purpose.
      queueMicrotask(() => {
        let retried: DownloadTaskData | null;
        try {
          retried = deps.engine.enqueueRetry(task.id);
        } catch (err) {
          // A full queue is the ordinary one. The record stays exactly as it
          // was, which is the honest thing to leave behind: a failed row with
          // a 重下 on it.
          deps.logger.warn(
            { task: task.id, code: task.error_code, err },
            'a download could not be retried automatically',
          );
          return;
        }
        if (retried === null) return;
        attempts.set(retried.id, made + 1);
        // The attempt just superseded is not a second line in the record.
        deps.history.remove(task.id);
        deps.logger.info(
          { task: task.id, retry: retried.id, attempt: made + 1, code: task.error_code },
          'retrying a failed download by itself',
        );
      });
    },
  };
}
