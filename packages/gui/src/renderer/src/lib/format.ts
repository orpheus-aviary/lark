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
