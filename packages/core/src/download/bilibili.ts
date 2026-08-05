// The bilibili API surface lark actually uses (M3-3), and nothing more.
//
// Split by signature requirement, because that split is load-bearing (R16):
//
//   - pagelist / view / playurl / fav / collection are UNSIGNED. They are the
//     whole deterministic path — a pasted URL downloads with no WBI, no LLM,
//     and no account.
//   - search is the only signed call. It is also the only one that needs the
//     LLM afterwards, so "keyword search" is exactly the feature that degrades
//     when either is unavailable, and nothing else does.
//
// Risk control is a first-class outcome, not a parse error: an interception
// answers HTTP 200 with an HTML body, so `response.ok` proves nothing. Every
// envelope goes through `readEnvelope`, which tells "bilibili said no" apart
// from "bilibili didn't answer at all".

import { BilibiliApiError, BilibiliRiskControlError, NormalizeFailedError } from '../errors.js';
import { DEFAULT_TIMEOUTS, type DownloadTimeouts, withTimeout } from './timeouts.js';
import { type Buvid, type WbiKeys, fetchBuvid, fetchWbiKeys, signWbiParams } from './wbi.js';

const DEFAULT_API_BASE = 'https://api.bilibili.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com';
/** WBI keys rotate daily; 30 minutes keeps us well inside that. */
const WBI_KEY_TTL_MS = 30 * 60_000;

/** Envelope codes that mean "you are being throttled / blocked", not "bad input". */
const RISK_CONTROL_CODES = new Set([-412, -509, -799]);

export interface BiliRequestOptions {
  signal?: AbortSignal;
}

export interface BiliSearchResult {
  bvid: string;
  title: string;
  author: string;
  mid: number;
  /** Seconds, parsed from bilibili's `mm:ss` string; null when unparseable. */
  duration: number | null;
  description: string;
}

export interface BiliPage {
  page: number;
  part: string;
  duration: number;
  cid: number;
}

export interface BiliView {
  bvid: string;
  title: string;
  ownerName: string;
  ownerMid: number;
  duration: number;
  /** Number of parts. `pages` carries them; a single-P video has one. */
  videos: number;
  pages: readonly BiliPage[];
}

export interface BiliAudioStream {
  url: string;
  bandwidth: number;
  /** bilibili's quality id: 30216 (64k) / 30232 (132k) / 30280 (192k). */
  id: number;
  mimeType: string;
}

export interface BiliListVideo {
  bvid: string;
  title: string;
  duration: number | null;
}

export interface BiliFavoritesPage {
  title: string;
  videos: readonly BiliListVideo[];
  hasMore: boolean;
}

export interface BiliCollectionPage {
  title: string;
  videos: readonly BiliListVideo[];
  /** Total across all pages, per the API's own count. */
  total: number;
}

export interface BilibiliClientOptions {
  /** Test seam. Production leaves this alone and uses the global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam: point every API call at a fake upstream. */
  apiBase?: string;
  timeouts?: DownloadTimeouts;
  /** Test seam for the WBI key cache TTL. */
  now?: () => number;
}

export interface BilibiliClient {
  search(
    keyword: string,
    options?: BiliRequestOptions & { page?: number },
  ): Promise<BiliSearchResult[]>;
  pagelist(bvid: string, options?: BiliRequestOptions): Promise<BiliPage[]>;
  view(bvid: string, options?: BiliRequestOptions): Promise<BiliView>;
  /** The highest-bandwidth audio-only stream for one part. */
  audioStream(bvid: string, cid: number, options?: BiliRequestOptions): Promise<BiliAudioStream>;
  favoritesPage(
    mediaId: string,
    pageNum: number,
    options?: BiliRequestOptions,
  ): Promise<BiliFavoritesPage>;
  collectionPage(
    mid: string,
    seasonId: string,
    pageNum: number,
    options?: BiliRequestOptions,
  ): Promise<BiliCollectionPage>;
  /** Follow a b23.tv short link exactly one hop and return the target URL. */
  expandShortLink(url: string, options?: BiliRequestOptions): Promise<string>;
  /** Open the audio stream for download. The caller owns the body. */
  openAudio(url: string, options?: BiliRequestOptions): Promise<Response>;
}

export function createBilibiliClient(options: BilibiliClientOptions = {}): BilibiliClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  const now = options.now ?? Date.now;

  let buvid: Buvid | null = null;
  let wbiKeys: WbiKeys | null = null;
  let wbiKeysAt = 0;

  const baseHeaders = (): Record<string, string> => ({ 'User-Agent': UA, Referer: REFERER });

  /**
   * Headers with the anonymous identity cookie. The buvid is fetched once per
   * client and reused: a fresh buvid on every request is itself a signal.
   */
  const headers = async (signal: AbortSignal): Promise<Record<string, string>> => {
    buvid ??= await fetchBuvid(fetchImpl, baseHeaders(), signal);
    const cookie = [
      `buvid3=${buvid.buvid3}`,
      ...(buvid.buvid4 ? [`buvid4=${buvid.buvid4}`] : []),
    ].join('; ');
    return { ...baseHeaders(), Cookie: cookie };
  };

  const keys = async (signal: AbortSignal): Promise<WbiKeys> => {
    if (wbiKeys !== null && now() - wbiKeysAt < WBI_KEY_TTL_MS) return wbiKeys;
    wbiKeys = await fetchWbiKeys(fetchImpl, await headers(signal), signal);
    wbiKeysAt = now();
    return wbiKeys;
  };

  /** GET a `{code, message, data}` endpoint and hand back `data`. */
  const getJson = async (url: string, signal: AbortSignal): Promise<unknown> => {
    const response = await fetchImpl(url, { headers: await headers(signal), signal });
    const text = await response.text();
    return readEnvelope(url, response, text);
  };

  const metaSignal = (options?: BiliRequestOptions): AbortSignal =>
    withTimeout(timeouts.bilibiliMeta, options?.signal);

  return {
    async search(keyword, opts) {
      const signal = metaSignal(opts);
      const query = signWbiParams(
        {
          search_type: 'video',
          keyword,
          page: opts?.page ?? 1,
          page_size: 20,
        },
        await keys(signal),
        Math.floor(now() / 1000),
      );
      const data = await getJson(`${apiBase}/x/web-interface/wbi/search/type?${query}`, signal);
      const raw = asRecord(data)?.result;
      if (!Array.isArray(raw)) return [];
      const out: BiliSearchResult[] = [];
      for (const item of raw) {
        const r = asRecord(item);
        const bvid = str(r?.bvid);
        if (bvid === '') continue;
        out.push({
          bvid,
          title: cleanSearchTitle(str(r?.title)),
          author: str(r?.author),
          mid: num(r?.mid),
          duration: parseClockDuration(str(r?.duration)),
          description: str(r?.description),
        });
      }
      return out;
    },

    async pagelist(bvid, opts) {
      const signal = metaSignal(opts);
      const data = await getJson(
        `${apiBase}/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`,
        signal,
      );
      if (!Array.isArray(data)) throw new BilibiliApiError(`pagelist for ${bvid} was not a list`);
      return data.map(toPage);
    },

    async view(bvid, opts) {
      const signal = metaSignal(opts);
      const data = asRecord(
        await getJson(`${apiBase}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, signal),
      );
      const title = str(data?.title);
      if (title === '') throw new BilibiliApiError(`view for ${bvid} carried no title`);
      const owner = asRecord(data?.owner);
      const pages = Array.isArray(data?.pages) ? data.pages.map(toPage) : [];
      return {
        bvid: str(data?.bvid) || bvid,
        title,
        ownerName: str(owner?.name),
        ownerMid: num(owner?.mid),
        duration: num(data?.duration),
        videos: num(data?.videos) || Math.max(pages.length, 1),
        pages,
      };
    },

    async audioStream(bvid, cid, opts) {
      const signal = metaSignal(opts);
      const url = `${apiBase}/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=16&fourk=1`;
      const dash = asRecord(asRecord(await getJson(url, signal))?.dash);
      const streams = Array.isArray(dash?.audio) ? dash.audio : [];
      // Highest bandwidth wins — the tiers are 64k/132k/192k and there is no
      // reason to ship the user the worst one.
      let best: BiliAudioStream | null = null;
      for (const entry of streams) {
        const s = asRecord(entry);
        const streamUrl = str(s?.baseUrl) || str(s?.base_url);
        if (streamUrl === '') continue;
        const candidate: BiliAudioStream = {
          url: streamUrl,
          bandwidth: num(s?.bandwidth),
          id: num(s?.id),
          mimeType: str(s?.mimeType) || str(s?.mime_type),
        };
        if (best === null || candidate.bandwidth > best.bandwidth) best = candidate;
      }
      if (best === null) {
        throw new BilibiliApiError(
          `no audio stream for ${bvid}:${cid} (video may be members-only)`,
        );
      }
      return best;
    },

    async favoritesPage(mediaId, pageNum, opts) {
      const signal = metaSignal(opts);
      const url = `${apiBase}/x/v3/fav/resource/list?media_id=${encodeURIComponent(mediaId)}&ps=20&pn=${pageNum}`;
      const data = asRecord(await getJson(url, signal));
      if (data === null) {
        throw new BilibiliApiError(`favorites ${mediaId} is private or does not exist`);
      }
      const medias = Array.isArray(data.medias) ? data.medias : [];
      return {
        title: str(asRecord(data.info)?.title),
        videos: medias.map(toListVideo).filter((v) => v.bvid !== ''),
        // `ps=20` is a request, not a promise — a page legitimately comes back
        // short (15 of 20 was the live observation), so only `has_more` may
        // decide whether to keep paging.
        hasMore: data.has_more === true,
      };
    },

    async collectionPage(mid, seasonId, pageNum, opts) {
      const signal = metaSignal(opts);
      const url =
        `${apiBase}/x/polymer/web-space/seasons_archives_list` +
        `?mid=${encodeURIComponent(mid)}&season_id=${encodeURIComponent(seasonId)}` +
        `&page_num=${pageNum}&page_size=30`;
      const data = asRecord(await getJson(url, signal));
      const archives = Array.isArray(data?.archives) ? data.archives : [];
      return {
        title: str(asRecord(data?.meta)?.name),
        videos: archives.map(toListVideo).filter((v) => v.bvid !== ''),
        total: num(asRecord(data?.page)?.total),
      };
    },

    async expandShortLink(url, opts) {
      const signal = withTimeout(timeouts.b23Expand, opts?.signal);
      let response: Response;
      try {
        // `manual` so the redirect is DATA, not something fetch silently
        // follows into an arbitrary host.
        response = await fetchImpl(url, {
          headers: baseHeaders(),
          redirect: 'manual',
          signal,
        });
      } catch (err) {
        throw new NormalizeFailedError(`could not expand short link ${url}`, { cause: err });
      }
      const location = response.headers.get('location');
      if (location === null || location === '') {
        throw new NormalizeFailedError(
          `short link ${url} did not redirect (HTTP ${response.status})`,
        );
      }
      return location;
    },

    async openAudio(url, opts) {
      const signal = withTimeout(timeouts.audioStream, opts?.signal);
      const response = await fetchImpl(url, { headers: await headers(signal), signal });
      if (!response.ok) {
        throw new BilibiliApiError(`audio stream returned HTTP ${response.status}`);
      }
      return response;
    },
  };
}

// ─── Envelope + field readers ──────────────────────────

/**
 * Turn a raw response into `data`, or into the right error class.
 *
 * The HTML check comes first and does not consult `response.ok`: the risk
 * control page IS an HTTP 200, and that is precisely the failure the Go
 * version could not see.
 */
function readEnvelope(url: string, response: Response, text: string): unknown {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new BilibiliRiskControlError(
      `bilibili answered ${url} with ${contentType || 'no content-type'} (HTTP ${response.status}) — likely a risk-control page`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BilibiliApiError(`unparseable response from ${url}: ${text.slice(0, 120)}`);
  }
  const envelope = asRecord(body);
  const code = num(envelope?.code);
  if (code !== 0) {
    const message = str(envelope?.message) || 'no message';
    if (RISK_CONTROL_CODES.has(code)) {
      throw new BilibiliRiskControlError(`bilibili risk control (code ${code}): ${message}`);
    }
    throw new BilibiliApiError(`bilibili API error ${code}: ${message}`, code);
  }
  return envelope?.data ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toPage(entry: unknown): BiliPage {
  const p = asRecord(entry);
  return {
    page: num(p?.page),
    part: str(p?.part),
    duration: num(p?.duration),
    cid: num(p?.cid),
  };
}

function toListVideo(entry: unknown): BiliListVideo {
  const v = asRecord(entry);
  return {
    bvid: str(v?.bvid),
    title: decodeEntities(str(v?.title)),
    duration: num(v?.duration) || null,
  };
}

/**
 * Search results wrap the matched words in `<em class="keyword">…</em>`. It
 * has to go before the title reaches the LLM (it is noise in the prompt) or a
 * song name (it would be stored verbatim).
 */
export function cleanSearchTitle(title: string): string {
  return decodeEntities(title.replace(/<\/?em[^>]*>/g, '')).trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // last: an encoded `&amp;quot;` must not become `"`
}

/** bilibili's search results carry duration as `mm:ss` (sometimes `h:mm:ss`). */
export function parseClockDuration(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  let seconds = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    seconds = seconds * 60 + Number(part);
  }
  return seconds;
}
