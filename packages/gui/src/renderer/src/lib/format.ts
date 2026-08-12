// Display formatting for the library view. Go-version parity, adjusted to the
// TS wire types: timestamps are unix milliseconds here, not ISO strings.

/** `m:ss` — the Go version's zero-padded minutes shape. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** Empty for a missing/zero size — an unknown size shows nothing, not "0 MB". */
export function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '';
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * "刚刚" / "3 分钟前" / "2 小时前", falling back to the absolute stamp past a
 * day (v0.2 T4). A sync that last ran on Tuesday is better said as a date than
 * as "97 小时前" — the relative form stops being readable long before that.
 *
 * `now` is a parameter rather than a `Date.now()` call so the caller controls
 * the clock and the test does not have to fake one.
 */
export function formatRelativeTime(ms: number, now: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const elapsed = now - ms;
  if (elapsed < 0) return '刚刚'; // a clock that ran backwards is not "in -3 分钟"
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return formatDateTime(ms);
}

/** Local `YYYY-MM-DD HH:mm:ss` from a unix-ms timestamp. */
export function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
