// Every outbound deadline in the download pipeline, in one place (M3-14).
//
// Collected rather than scattered because the Go version had them inline and
// nobody could answer "how long can one task hang for?" without grepping. The
// answer now is: read this file.
//
// The rule that goes with them: EVERY outbound call composes its deadline with
// the task/request signal AND the daemon's shutdown signal —
// `AbortSignal.any([taskSignal, shutdownSignal, AbortSignal.timeout(N)])`. A
// call that only carries its own timeout keeps `server.close()` waiting for up
// to that timeout, which is how a 10-minute ffmpeg turns a Ctrl-C into a hang.

export interface DownloadTimeouts {
  /** pagelist / view / playurl / search / fav / collection metadata calls. */
  bilibiliMeta: number;
  /** b23.tv → real URL, a single redirect hop. */
  b23Expand: number;
  /** The audio stream itself, start to finish. */
  audioStream: number;
  /** One LLM completion. */
  llm: number;
  /**
   * The LLM's turn at picking a lyrics candidate — much shorter than `llm`,
   * because this call is a REFINEMENT with a deterministic fallback that costs
   * a millisecond (`pickByHeuristic`).
   *
   * Measured 2026-08-17 against deepseek-v4-flash, nine candidates: 2.3s, 16.6s
   * and 22.8s on three consecutive runs, agreeing with the heuristic every
   * time. Waiting a minute for a maybe-better answer is the wrong trade when
   * every song's lyrics now run between two downloads (§3.6-3).
   */
  lyricsSelect: number;
  /** One lyrics platform, search + fetch combined. */
  lyricsPlatform: number;
  ffprobe: number;
  ffmpeg: number;
  /** Whole-request budget for pre-enqueue network checks, across all items. */
  preflight: number;
}

export const DEFAULT_TIMEOUTS: DownloadTimeouts = {
  bilibiliMeta: 15_000,
  b23Expand: 10_000,
  audioStream: 5 * 60_000,
  llm: 60_000,
  lyricsSelect: 10_000,
  lyricsPlatform: 20_000,
  ffprobe: 30_000,
  ffmpeg: 10 * 60_000,
  preflight: 60_000,
};

/**
 * Compose a deadline with the caller's cancellation. `undefined` signals are
 * dropped, so a call site never has to branch on "do I have a signal here".
 */
export function withTimeout(
  timeoutMs: number,
  ...signals: (AbortSignal | undefined)[]
): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  return AbortSignal.any([...present, AbortSignal.timeout(timeoutMs)]);
}

/**
 * `signal.throwIfAborted()`, for a host that does not have it.
 *
 * MEASURED (N4e-2, frozen device, release build): this React Native runtime
 * has `AbortSignal.any` and `AbortSignal.timeout` — the STATICS — but
 * `AbortSignal.prototype.throwIfAborted` is `undefined`, and so is
 * `throwIfAborted` on the signal `any()` hands back. A HALF-MODERN
 * implementation, which is the worst shape to guess at: `withTimeout` works
 * everywhere on the phone, so nothing suggests the instance side is missing.
 *
 * What it cost before it was found: the ONE call site was inside the handler
 * that makes `clean` naming degrade to the original title. Any LLM failure
 * therefore blew that handler up with `TypeError: undefined is not a function`
 * and took the whole download with it — a graceful-degradation path that was
 * itself the crash, reported as INTERNAL_ERROR with the real error going to a
 * logger the phone did not have.
 *
 * No `DOMException`: it is not in this runtime's vocabulary either, and the
 * only thing anything downstream reads is `name === 'AbortError'`
 * (`shared/transport.ts`, `download/preflight.ts`).
 */
export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = (signal as { reason?: unknown }).reason;
  if (reason instanceof Error) throw reason;
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  throw err;
}
