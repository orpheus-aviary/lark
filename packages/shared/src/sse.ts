// Server-Sent Events client for `GET /events`, host-agnostic (routes through
// the configured transport: base URL + auth headers). Replaces native
// `EventSource`, which cannot carry an `Authorization` header.
//
// Ported from owl minus its POST `streamSse` (lark has no streaming POST) and
// with two additions the gui channel needs (M2-14):
//   - each attempt takes ONE headers snapshot, used both as the request
//     headers and to derive `usedToken` — so a disconnect always reports the
//     token that attempt actually sent, even if the file rotated meanwhile;
//   - `onDisconnect` may return `'stop'` to end the retry loop. Without it a
//     daemon restart's `409 GUI_REGISTRATION_REQUIRED` would be retried
//     forever with the same dead gui_id; the recovery flow is stop → re-register
//     → new AbortController + new gui_id → subscribe again.
//
// Wire grammar (https://html.spec.whatwg.org/multipage/server-sent-events.html):
//   event-block := (line "\n")+ ; two newlines terminate a block; `:` comment.

import { authHeaders, baseUrl } from './transport.js';

export class SseHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
  ) {
    super(`SSE request failed: ${status} ${statusText}`);
    this.name = 'SseHttpError';
  }
}

export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

/**
 * Parse one event block into its event name + raw (un-decoded) data string.
 * Multi-line `data:` fields are joined with `\n`; `:`-comments (the keepalive)
 * and blank lines are skipped; a block with no `event:` field yields `null`.
 * Pure + exported so the framing logic is unit-testable without a stream.
 */
export function parseSseBlock(block: string, warn?: (msg: string) => void): SseFrame | null {
  let event = '';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trimStart();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    } else {
      warn?.(`unrecognised SSE line: ${line}`);
    }
  }
  if (!event) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * Read an SSE body stream chunk-by-chunk, splitting on `\n\n` boundaries and
 * invoking `onFrame` with each parsed (raw-data) frame. Resolves when the
 * stream ends or the caller aborts. Releases the reader on the way out.
 */
async function readFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onFrame: (frame: SseFrame) => void,
  warn: (msg: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const frame = parseSseBlock(buffer.slice(0, sep), warn);
        buffer = buffer.slice(sep + 2);
        if (frame) onFrame(frame);
        sep = buffer.indexOf('\n\n');
      }
    }
    // Drain a final un-terminated block (servers SHOULD end with \n\n).
    if (buffer.trim()) {
      const frame = parseSseBlock(buffer, warn);
      if (frame) onFrame(frame);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if the reader is mid-read; safe to ignore.
    }
  }
}

/** Payload of the exactly-once `onDisconnect` notification. */
export interface SseDisconnect {
  /** The error that ended the connection, or `null` for a clean close (EOF / no body). */
  readonly error: unknown;
  /** `true` when the stream ended without throwing (EOF / no body); `false` on error. */
  readonly clean: boolean;
  /**
   * The bare bearer token this attempt was opened with (no `Bearer ` prefix),
   * taken from the SAME headers snapshot the request used. `null` when no
   * `Authorization: Bearer …` header was configured.
   */
  readonly usedToken: string | null;
}

export interface SubscribeSseOptions {
  /** Path appended to the configured base URL. */
  path: string;
  /** Required — aborting it tears down the subscription (no manual reconnect). */
  signal: AbortSignal;
  /** Called for every event with the RAW `data` string (caller parses). */
  onEvent: (event: string, rawData: string) => void;
  /** Optional logger for malformed lines / connection errors. */
  warn?: (msg: string) => void;
  /**
   * Called EXACTLY ONCE per connection lifecycle end, before the backoff wait —
   * whether the attempt threw (`clean:false`) or the stream ended cleanly /
   * had no body (`clean:true`). NOT called when torn down via `signal.abort()`.
   *
   * Return `'stop'` to end the retry loop for good: a non-2xx rejection is
   * reported as an {@link SseHttpError} carrying `status` + `body`, so the
   * caller can distinguish "retry later" (network) from "this subscription is
   * invalid, re-register first" (409).
   */
  // `void` is what makes the return OPTIONAL: a handler that just logs infers
  // `void`, which a `'stop' | undefined` signature would reject.
  // biome-ignore lint/suspicious/noConfusingVoidType: deliberate — see above
  onDisconnect?: (info: SseDisconnect) => void | 'stop';
  /** Backoff schedule (ms) per consecutive failed attempt; reset on connect. */
  backoffMs?: readonly number[];
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000] as const;

/**
 * Subscribe to a GET SSE endpoint with automatic reconnect. Reconnects on any
 * close/error with the backoff schedule (reset on a successful connect) and
 * stops when `signal` aborts or `onDisconnect` returns `'stop'`.
 * Fire-and-forget: the loop owns its own lifecycle.
 */
export function subscribeSse(options: SubscribeSseOptions): void {
  const warn = options.warn ?? ((msg) => console.warn('[sse-subscribe]', msg));
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const { signal } = options;
  let attempt = 0;

  const connectOnce = async (headers: Record<string, string>): Promise<void> => {
    const response = await fetch(`${baseUrl()}${options.path}`, {
      method: 'GET',
      headers,
      signal,
    });
    if (!response.ok) {
      throw new SseHttpError(response.status, response.statusText, await safeReadText(response));
    }
    if (!response.body) return; // nothing to read → treat as a clean close
    attempt = 0; // connected — reset backoff
    await readFrames(
      response.body,
      signal,
      (frame) => options.onEvent(frame.event, frame.data),
      warn,
    );
  };

  const loop = async (): Promise<void> => {
    while (!signal.aborted) {
      // ONE snapshot per attempt: the request and the reported `usedToken`
      // must describe the same connection even if the token rotates mid-flight.
      const headers = { ...authHeaders(), Accept: 'text/event-stream' };
      const usedToken = bearerOf(headers);
      let error: unknown = null;
      let clean = true;
      try {
        await connectOnce(headers);
      } catch (err) {
        if (isAbortError(err) || signal.aborted) return; // torn down → no disconnect
        error = err;
        clean = false;
        warn(`subscribe ${options.path} error: ${String(err)}`);
      }
      if (signal.aborted) return; // aborted mid-connection → no disconnect
      // Exactly once per completed connection lifecycle, whether it threw or
      // ended cleanly. The abort paths above return before reaching here.
      if (options.onDisconnect?.({ error, clean, usedToken }) === 'stop') return;
      const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 0;
      attempt++;
      await sleep(delay, signal);
    }
  };

  void loop();
}

/** The bare bearer token inside a headers snapshot, or null. */
function bearerOf(headers: Record<string, string>): string | null {
  const auth = headers.Authorization ?? headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// ─── Internals ─────────────────────────────────────────

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR')
  );
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
