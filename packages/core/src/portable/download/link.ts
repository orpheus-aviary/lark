// Link recognition and online source normalisation (M3-10).
//
// This module is why a pasted URL needs no LLM. The Go version asked the model
// "is this a URL or a keyword?" and then let a regex overrule the answer,
// which meant an unconfigured LLM broke inputs the regex could read perfectly
// well. Here the deterministic parse IS the answer, and the LLM only sees
// input that is genuinely ambiguous (free text).
//
// Recognition is structural, not textual. `new URL()` first, then explicit
// checks on scheme / credentials / port / host — because
// `https://evil.test/?x=bilibili.com/video/BV1…` matches a naive regex and
// `https://user:pw@bilibili.com.evil.test/` matches a naive suffix test.
// Nothing here reaches the network; `resolveInput` and `normalizeSourceOnline`
// are the two functions that do.

import type { ParsedItem } from '@lark/shared';
import { BilibiliApiError, InvalidSourceError } from '../errors.js';
import type { BiliPage, BiliRequestOptions, BilibiliClient } from './bilibili.js';

/**
 * A bvid is base58: no `0`, `I`, `O` or `l`. Anchored, because an unanchored
 * match happily finds a "bvid" inside an arbitrary string.
 */
const BVID_RE = /^BV1[1-9A-HJ-NP-Za-km-z]{9}$/;

/**
 * Is this string a bvid? Exported so a route can refuse a malformed one with a
 * 400 instead of forwarding it and reporting bilibili's confusion (0.5.1).
 */
export function isBvid(text: string): boolean {
  return BVID_RE.test(text);
}

/** The same character class, for pulling a bvid out of a URL path segment. */
const BVID_IN_PATH_RE = /^BV1[1-9A-HJ-NP-Za-km-z]{9}$/;

const SPACE_HOST = 'space.bilibili.com';
const SHORT_LINK_HOST = 'b23.tv';

/**
 * Hosts a scheme-less paste may be repaired against.
 *
 * Copying out of a browser's address bar drops `https://`, and without this
 * `www.bilibili.com/video/BV1…` parses as free text — which then goes to the
 * LLM as a search query and comes back with something else entirely.
 *
 * The trailing slash is what makes this safe as a prefix test:
 * `bilibili.com.evil.test/` does not start with `bilibili.com/`. Repairing
 * only prepends the scheme; every check below (scheme, credentials, port,
 * host) still runs on the result.
 */
const SCHEMELESS_PREFIXES = [
  'bilibili.com/',
  'www.bilibili.com/',
  'm.bilibili.com/',
  'space.bilibili.com/',
  `${SHORT_LINK_HOST}/`,
];

/**
 * A short link cannot be classified without a network hop, so it is its own
 * kind here and never escapes to the wire — `resolveInput` expands it and
 * re-parses, and only `ParsedItem` reaches a caller.
 */
export type ParsedInput = ParsedItem | { kind: 'short_link'; url: string };

/** Canonical watch URL. `?p=1` is dropped: page 1 is the default (R30). */
export function buildVideoUrl(bvid: string, page: number): string {
  const base = `https://www.bilibili.com/video/${bvid}`;
  return page > 1 ? `${base}?p=${page}` : base;
}

/**
 * Classify ONE line of input, offline and deterministically.
 *
 * Order matters: the two `space.bilibili.com` forms are checked before the
 * generic video branch, and the bare-bvid branch after the URL branches, so a
 * URL is never mistaken for a keyword because it happens to contain a bvid.
 */
export function parseSongInput(raw: string): ParsedInput {
  const text = raw.trim();
  if (text === '') throw new InvalidSourceError('输入为空');

  if (BVID_RE.test(text)) {
    return { kind: 'video', bvid: text, page: null, url: buildVideoUrl(text, 1) };
  }

  const url = safeUrl(text) ?? repairSchemeless(text);
  // Not a URL at all → free text. This is the ONLY branch that needs an LLM.
  if (url === null) return { kind: 'keyword', query: text };

  assertSafeUrlShape(url);

  if (url.hostname === SHORT_LINK_HOST) {
    return { kind: 'short_link', url: url.toString() };
  }

  if (!isBilibiliHost(url.hostname)) {
    throw new InvalidSourceError(
      `${url.hostname} 不是 B 站链接，无法用于下载（可以把它存进歌曲的链接字段，但下载只支持 bilibili.com）`,
    );
  }

  if (url.hostname === SPACE_HOST) {
    const favorites = parseFavorites(url);
    if (favorites !== null) return favorites;
    const collection = parseCollection(url);
    if (collection !== null) return collection;
  }

  const video = parseVideo(url);
  if (video !== null) return video;

  throw new InvalidSourceError(`无法识别的 B 站链接：${url.pathname}（支持视频页、收藏夹、合集）`);
}

/**
 * `parseSongInput` plus at most ONE short-link expansion. The expanded target
 * is re-validated from scratch — b23.tv can redirect anywhere, and a link that
 * lands off bilibili must be refused exactly as if it had been pasted directly.
 *
 * A target that is STILL a short link is an `InvalidSourceError` (400-shaped),
 * not a `NormalizeFailedError` (502): from the caller's point of view a link
 * that will not resolve to a video is a bad input, the same verdict pasting a
 * bangumi URL gets. This is the daemon route's long-standing behaviour, made
 * true of the one shared implementation the preflight now extracts (§1.2).
 */
export async function resolveInput(
  client: BilibiliClient,
  raw: string,
  options?: BiliRequestOptions,
): Promise<ParsedItem> {
  const parsed = parseSongInput(raw);
  if (parsed.kind !== 'short_link') return parsed;

  const target = await client.expandShortLink(parsed.url, options);
  const expanded = parseSongInput(target);
  if (expanded.kind === 'short_link') {
    throw new InvalidSourceError(`短链 ${parsed.url} 展开后仍是短链，拒绝继续跟随`);
  }
  return expanded;
}

export interface NormalizedSource {
  source_url: string;
  source_provider: 'bilibili';
  /** `bvid:cid` — the identity that survives a re-numbered `?p=` (R30). */
  source_key: string;
  bvid: string;
  page: number;
  cid: number;
  pages: readonly BiliPage[];
}

/**
 * Resolve `bvid` + optional page into a stable identity, online.
 *
 * The p → cid hop is the entire point: `?p=3` is a POSITION and the uploader
 * can reorder it, while the cid is the part itself. An out-of-range page is an
 * error rather than the Go version's silent fall back to p1 — quietly
 * downloading a different song than the URL named is worse than failing.
 */
export async function normalizeSourceOnline(
  client: BilibiliClient,
  input: { bvid: string; page: number | null },
  options?: BiliRequestOptions,
): Promise<NormalizedSource> {
  const pages = await client.pagelist(input.bvid, options);
  if (pages.length === 0) {
    throw new BilibiliApiError(`${input.bvid} 没有可用的分P信息`);
  }
  const page = input.page ?? 1;
  if (page < 1 || page > pages.length) {
    throw new InvalidSourceError(`?p=${page} 越界：${input.bvid} 只有 ${pages.length} 个分P`);
  }
  const cid = pages[page - 1]?.cid ?? 0;
  if (cid === 0) throw new BilibiliApiError(`${input.bvid} 的第 ${page} 个分P没有 cid`);

  return {
    source_url: buildVideoUrl(input.bvid, page),
    source_provider: 'bilibili',
    source_key: `${input.bvid}:${cid}`,
    bvid: input.bvid,
    page,
    cid,
    pages,
  };
}

// ─── Structural URL checks ─────────────────────────────

function safeUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/**
 * Put `https://` back on a bilibili URL that lost it, or `null` to leave the
 * text alone. Whitespace disqualifies it: a sentence that happens to start
 * with a host is a search, not a link.
 */
function repairSchemeless(text: string): URL | null {
  if (/\s/.test(text)) return null;
  if (!SCHEMELESS_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
  return safeUrl(`https://${text}`);
}

/**
 * Reject the shapes that make host checks lie. Credentials because
 * `https://bilibili.com@evil.test/` reads as bilibili to a human; a non-default
 * port because a loopback redirect is not what a user pasting a bilibili link
 * has in mind; plain http because everything here is https in practice and
 * allowing it only widens what an interceptor can rewrite.
 */
function assertSafeUrlShape(url: URL): void {
  if (url.protocol !== 'https:') {
    throw new InvalidSourceError(`只支持 https 链接，收到 ${url.protocol.replace(':', '')}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new InvalidSourceError('链接不能携带用户名/密码');
  }
  if (url.port !== '') {
    throw new InvalidSourceError('链接不能指定端口');
  }
}

/** Exact domain or a real subdomain — never a suffix match on the string. */
function isBilibiliHost(hostname: string): boolean {
  return hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com');
}

/** `space.bilibili.com/<mid>/favlist?fid=<media_id>` */
function parseFavorites(url: URL): ParsedItem | null {
  const segments = pathSegments(url);
  if (segments.length !== 2 || segments[1] !== 'favlist') return null;
  const mid = segments[0] ?? '';
  if (!/^\d+$/.test(mid)) return null;
  const fid = url.searchParams.get('fid') ?? '';
  if (!/^\d+$/.test(fid)) {
    throw new InvalidSourceError('收藏夹链接缺少 fid 参数');
  }
  return { kind: 'favorites', media_id: fid, url: url.toString() };
}

/** `space.bilibili.com/<mid>/lists/<season_id>` */
function parseCollection(url: URL): ParsedItem | null {
  const segments = pathSegments(url);
  if (segments.length !== 3 || segments[1] !== 'lists') return null;
  const mid = segments[0] ?? '';
  const seasonId = segments[2] ?? '';
  if (!/^\d+$/.test(mid) || !/^\d+$/.test(seasonId)) return null;
  return { kind: 'collection', mid, season_id: seasonId, url: url.toString() };
}

/** `www.bilibili.com/video/<bvid>` with an optional `?p=`. */
function parseVideo(url: URL): ParsedItem | null {
  const segments = pathSegments(url);
  const videoAt = segments.indexOf('video');
  if (videoAt === -1) return null;
  const candidate = segments[videoAt + 1] ?? '';
  if (!BVID_IN_PATH_RE.test(candidate)) {
    throw new InvalidSourceError(
      `视频链接里的 id 不是合法 BV 号：${candidate || '(缺失)'}（av 号请换成 BV 链接）`,
    );
  }
  return { kind: 'video', bvid: candidate, page: parsePage(url), url: url.toString() };
}

function parsePage(url: URL): number | null {
  const raw = url.searchParams.get('p');
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) throw new InvalidSourceError(`?p= 必须是正整数，收到 ${raw}`);
  const page = Number(raw);
  if (page < 1) throw new InvalidSourceError('?p= 必须从 1 开始');
  return page;
}

function pathSegments(url: URL): string[] {
  return url.pathname.split('/').filter((s) => s !== '');
}
