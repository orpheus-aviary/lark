// What the three lyrics platforms have in common (M3-9): where they live, how
// they are called, and the tolerant JSON readers each one needs.
//
// Every platform is best-effort by construction — one that is down, has
// changed its JSON, or simply has no match returns an empty list and the run
// continues on whatever the other two found. Lyrics are the one part of a
// download allowed to come back empty.

import { DEFAULT_TIMEOUTS, type DownloadTimeouts, withTimeout } from '../timeouts.js';

/** Per-platform candidate cap (Go parity) — the pool tops out at 9. */
export const MAX_CANDIDATES = 3;

export const UA = 'Mozilla/5.0';

/**
 * Production origins. Tests point these at a local fake upstream.
 *
 * Kugou is https here. The Go version used plain http for
 * `krcs.kugou.com/search` and `lyrics.kugou.com/download`; both answer over
 * TLS (verified 2026-08-05) and there was never a reason to ship lyrics
 * queries in clear text.
 */
export interface LyricsOrigins {
  netease: string;
  qq: string;
  kugouSearch: string;
  kugouKrc: string;
  kugouLyrics: string;
}

export const LYRICS_ORIGINS: LyricsOrigins = {
  netease: 'https://music.163.com',
  qq: 'https://c.y.qq.com',
  kugouSearch: 'https://mobileservice.kugou.com',
  kugouKrc: 'https://krcs.kugou.com',
  kugouLyrics: 'https://lyrics.kugou.com',
};

export interface LyricsSourceOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeouts?: DownloadTimeouts;
  origins?: Partial<LyricsOrigins>;
}

export interface LyricsQuery {
  name: string;
  artist: string;
  /** Audio length in seconds; Kugou's lyric search matches on it. */
  duration: number;
}

export interface ResolvedSourceOptions {
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  origins: LyricsOrigins;
}

/**
 * ONE deadline for a platform's whole chain (search plus up to three lyric
 * fetches), not per request — otherwise a platform that answers slowly forever
 * outlasts the task that is waiting for it.
 */
export function resolveSourceOptions(options: LyricsSourceOptions): ResolvedSourceOptions {
  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  return {
    fetchImpl: options.fetchImpl ?? fetch,
    signal: withTimeout(timeouts.lyricsPlatform, options.signal),
    origins: { ...LYRICS_ORIGINS, ...options.origins },
  };
}

export const searchTerm = (query: LyricsQuery): string =>
  query.artist === '' ? query.name : `${query.name} ${query.artist}`;

export async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  // These endpoints are inconsistent about content-type (QQ answers
  // text/javascript for `format=json`), so the body is parsed regardless.
  return JSON.parse(await response.text());
}

/** QQ and Kugou both hand back base64 LRC. `null` = nothing usable. */
export function decodeBase64(value: string): string | null {
  if (value === '') return null;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf-8');
    return decoded === '' ? null : decoded;
  } catch {
    return null;
  }
}

export function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** `artists[0].name` / `singer[0].name` — netease and QQ use the same shape. */
export function firstName(value: unknown): string {
  return str(rec(arr(value)[0])?.name);
}
