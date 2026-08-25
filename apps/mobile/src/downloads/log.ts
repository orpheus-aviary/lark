// What the download engine has had to say for itself (N4e-2).
//
// `describeTaskError` answers INTERNAL_ERROR with fixed text — "下载任务出现内部
// 错误，详情见日志" — and hands the RAW error to the engine's logger, because a
// raw error can carry a SQLite path or an upstream response body and neither
// belongs on the wire (fifth review ⑩). On the desktop that logger is pino and
// the sentence is true.
//
// On this phone the engine was constructed with no logger at all, so it is
// NOOP_LOGGER: the sentence points at a log that does not exist, and an
// unexplained failure is unexplainable BY CONSTRUCTION — release builds do not
// reach logcat either.
//
// So this ring is the log, and the settings page is where it is read. It was
// added to get one specific INTERNAL_ERROR out of the device and stayed
// because it paid for itself three times in one session — the runtime's
// missing `throwIfAborted`, and both silent naming fallbacks.
//
// IT IS NO LONGER THE DOWNLOAD ENGINE'S. The cache runtime writes here too,
// and from N5c so does the sync coordinator — which is why the ring is 10
// lines rather than 5: two talkative subsystems sharing five would mean the
// louder one erases the other's only evidence. The name stayed `engineLogger`
// because renaming it is churn across three files; the settings page label did
// not, because "最近的下载错误" over a sync failure is a lie a user reads.
//
// ⚠️ IT CARRIES RAW ERRORS, and a raw error can carry a provider's response
// body (§1.4) or — since N5c — a skybridge server URL. Redaction was
// deliberately not done (§8.2), so this screen can in principle show something
// a screen should not. The exposure is bounded —
// five lines, in-memory, gone on restart, and never on the wire — and it is
// the price of an INTERNAL_ERROR being explainable at all. Revisit it with
// redaction, not by taking the window away again.

import type { StructuredLogger } from '@lark/core/portable';

const RING = 10;
const lines: string[] = [];
const listeners = new Set<() => void>();

function describe(value: unknown): string {
  if (value instanceof Error) {
    const frame = (value.stack ?? '').split('\n')[1]?.trim() ?? '';
    return `${value.name}: ${value.message}${frame === '' ? '' : ` @ ${frame}`}`;
  }
  return String(value);
}

function push(line: string): void {
  lines.unshift(line);
  if (lines.length > RING) lines.pop();
  for (const listener of listeners) listener();
}

/** What the engine has had to say for itself. Newest first. */
export function engineErrors(): readonly string[] {
  return lines;
}

export function subscribeEngineErrors(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const engineLogger: StructuredLogger = {
  debug: () => {},
  info: () => {},
  warn: (fields, msg) =>
    push(`warn ${msg} · ${'err' in fields ? describe(fields.err) : JSON.stringify(fields)}`),
  error: (fields, msg) => push(`${msg} · ${describe(fields.err)}`),
};
