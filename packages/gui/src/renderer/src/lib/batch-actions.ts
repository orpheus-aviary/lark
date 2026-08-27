// Running one action over a selection (S3/B-7).
//
// Sequential, never concurrent: pinning, removing and deleting all take the
// song's claim on the daemon side, and firing ten at once would just make them
// refuse each other with 409s. Ten requests in a row is fine at library scale.
//
// A batch is allowed to be PARTLY successful — the eighth song may have been
// deleted by another window a second ago — so the runner never stops at the
// first failure and never throws. It counts, and the caller says so.

export interface BatchOutcome {
  total: number;
  ok: number;
  failed: number;
  /** The first failure's message: naming one beats a count with no reason. */
  firstError: string | null;
}

export async function runBatch(
  ids: readonly string[],
  action: (id: string) => Promise<void>,
  describeError: (err: unknown) => string,
): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { total: ids.length, ok: 0, failed: 0, firstError: null };
  for (const id of ids) {
    try {
      await action(id);
      outcome.ok++;
    } catch (err) {
      outcome.failed++;
      outcome.firstError ??= describeError(err);
    }
  }
  return outcome;
}

export interface BatchMessage {
  text: string;
  ok: boolean;
}

/**
 * What to tell the user. `verb` is the past-tense action ("已固定"), used as
 * the stem for all three shapes so a partial batch reads like the whole one.
 *
 * `note` is for a batch that did not run over the whole selection — the rows
 * the caller left out, and why. It is appended to every shape, failures
 * included: "已开始下载 3 首" over a selection of twelve is a true sentence
 * that reads like a bug until it says what happened to the other nine.
 */
export function batchMessage(outcome: BatchOutcome, verb: string, note?: string): BatchMessage {
  const reason = outcome.firstError === null ? '' : `：${outcome.firstError}`;
  const tail = note === undefined || note === '' ? '' : `；${note}`;
  if (outcome.failed === 0) return { text: `${verb} ${outcome.ok} 首${tail}`, ok: true };
  if (outcome.ok === 0) return { text: `${verb}失败${reason}${tail}`, ok: false };
  return {
    text: `${verb} ${outcome.ok} 首，${outcome.failed} 首失败${reason}${tail}`,
    ok: false,
  };
}
