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
