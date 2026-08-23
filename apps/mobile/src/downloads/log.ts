// ⚠️ TEMPORARY DIAGNOSTIC (N4e-2 device session, 2026-08-23).
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
// This ring is here to get one specific INTERNAL_ERROR read out during the N4e
// device session. IT IS NOT THE PERMANENT ANSWER: putting raw errors on the
// settings screen is exactly the §1.4 leak path that criterion 30 is about, so
// what a phone should show instead of "详情见日志" is a decision to take
// deliberately, not a diagnostic to leave lying around.

import type { StructuredLogger } from '@lark/core/portable';

const RING = 5;
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

/**
 * ⚠️ TEMPORARY probe: which of the modern AbortSignal APIs does THIS runtime
 * have? RN polyfills `AbortSignal` with the `abort-controller` package, which
 * has none of them — yet `withTimeout` (= `AbortSignal.any`) works for every
 * bilibili call on this device, so something else is winning. The answer
 * decides whether `pipeline.ts:226` is the only casualty.
 */
export function abortSignalSupport(): string {
  const anyFn = (AbortSignal as unknown as { any?: unknown }).any;
  const timeoutFn = (AbortSignal as unknown as { timeout?: unknown }).timeout;
  const proto = (AbortSignal as unknown as { prototype?: Record<string, unknown> }).prototype;
  let composed = 'n/a';
  try {
    const signal = AbortSignal.any([new AbortController().signal]);
    composed = `any()→${typeof (signal as unknown as { throwIfAborted?: unknown }).throwIfAborted}`;
  } catch (err) {
    composed = `any() threw ${err instanceof Error ? err.message : String(err)}`;
  }
  return (
    `any=${typeof anyFn} · timeout=${typeof timeoutFn} · ` +
    `proto.throwIfAborted=${typeof proto?.throwIfAborted} · ${composed}`
  );
}
