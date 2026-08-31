// Pre-enqueue judgement, extracted from the daemon route (N4a, subplan §2.4).
//
// The division of labour with the engine is unchanged: NETWORK WORK HAPPENS
// HERE, SCHEDULING HAPPENS THERE. What moved is the set of DECISIONS a request
// needs before it can enqueue — expand a short link, decide whether the LLM is
// required, refuse a list link, walk a favourites folder — which used to live
// only in `daemon/src/routes/download.ts`. A second front end (the phone,
// N4d) would have written them again, and there is no second implementation to
// catch the drift the way `link.test.ts` caught this module's own (§1.2).
//
// What stays with the caller is REQUEST-SHAPE validation: a video with no
// `naming_mode`, a keyword that carries one. Those describe the request, not
// the download's feasibility, and a wire and a native form owe their callers
// different words for them — the daemon says INVALID_BODY, the phone renders it
// inline. Everything here speaks core error classes and knows nothing of HTTP.

import {
  type DownloadBatchGroupInput,
  type DownloadNamingMode,
  type DownloadPartsData,
  FETCH_LIST_ITEMS_MAX,
  FETCH_LIST_PAGES_MAX,
  type FetchListData,
  type FetchListRequest,
  type ParsedItem,
} from '@lark/shared';
import {
  InvalidSourceError,
  LlmNotConfiguredError,
  MultiPartUnresolvedError,
  PreflightTimeoutError,
} from '../errors.js';
import type { BiliRequestOptions, BilibiliClient } from './bilibili.js';
import { resolveInput } from './link.js';
import type { DownloadTarget } from './target.js';

/** What the preflight needs about the environment: the client and the LLM gate. */
export interface PreflightDeps {
  client: BilibiliClient;
  /** Is an LLM configured for this request? Decides the three gates below. */
  hasLlm: boolean;
}

/**
 * Expand a short link if there is one, and reject anything not bilibili.
 *
 * Exactly `resolveInput`: parse offline, then at most one b23.tv hop, the
 * target re-validated from scratch. Named for the preflight surface so a caller
 * reads one coherent vocabulary; the implementation is the one link.test.ts
 * already pins.
 */
export function resolveOne(
  client: BilibiliClient,
  input: string,
  options?: BiliRequestOptions,
): Promise<ParsedItem> {
  return resolveInput(client, input, options);
}

/**
 * The single-input preflight: the three LLM gates and the list rejection.
 *
 *   keyword and no LLM             → LLM_NOT_CONFIGURED
 *   clean naming and no LLM        → LLM_NOT_CONFIGURED
 *   multi-part with no ?p=         → MULTI_PART_UNRESOLVED (0.5.1, any LLM)
 *   a favourites / collection link → INVALID_SOURCE (use fetch-list)
 *
 * The page list is fetched here for the multi-part gate because it is needed
 * for p → cid anyway, so asking it is free — and it is the only way to know
 * whether a part still has to be named. A `naming_mode` for a video is assumed
 * present (the caller validates request shape); a video reaching this without
 * one is a caller bug, not a user error.
 */
export async function preflightSingle(
  deps: PreflightDeps,
  item: ParsedItem,
  namingMode: DownloadNamingMode | undefined,
  options?: BiliRequestOptions,
): Promise<DownloadTarget> {
  if (item.kind === 'keyword') {
    if (!deps.hasLlm) {
      throw new LlmNotConfiguredError('关键词搜索需要配置 LLM；或者直接粘贴 B 站视频链接');
    }
    return { kind: 'keyword', query: item.query };
  }
  if (item.kind !== 'video') {
    throw new InvalidSourceError(
      '收藏夹和合集链接请先用 /download/fetch-list 展开，再用 /download/batch 下载',
    );
  }
  // The caller answers the request-shape refusal (INVALID_BODY) before this;
  // reaching here without a mode is a bug in the caller, so it is a source
  // error rather than a silent default to one of the two modes.
  if (namingMode === undefined) {
    throw new InvalidSourceError('视频下载需要命名模式（original 或 clean）');
  }
  if (namingMode === 'clean' && !deps.hasLlm) {
    throw new LlmNotConfiguredError('清洗命名需要配置 LLM；或者用 naming_mode=original 保留原标题');
  }
  // 🔴 NOT AN LLM GATE ANY MORE (0.5.1 §7.3-e). It used to refuse only when
  // there was no model, because a model would pick a part — and answer "1"
  // whenever it could not tell. Now nothing guesses, so this refuses whatever
  // is configured, and says the three things that DO answer it. Sending
  // somebody to the settings page for this would have been a dead end.
  if (item.page === null) {
    const pages = await withPreflightBudget(() => deps.client.pagelist(item.bvid, options));
    if (pages.length > 1) {
      throw new MultiPartUnresolvedError(
        `这个视频有 ${pages.length} 个分P：在链接后加 ?p=<编号>，或选择要下哪几个分P`,
      );
    }
  }
  return { kind: 'video', bvid: item.bvid, page: item.page, title: null, naming: namingMode };
}

/**
 * The batch LLM gate, answered with no network at all.
 *
 * A keyword item, or a `clean` video item, needs the model; a 200 followed by
 * fifty tasks failing one by one for a knowable reason is the wrong answer.
 * The rest of a batch's validation — playlist targets, malformed bvids, the
 * item ceilings — is request shape and stays with the caller.
 */
export function preflightBatch(
  deps: PreflightDeps,
  groups: readonly DownloadBatchGroupInput[],
): void {
  const hasKeyword = groups.some((g) => g.items.some((i) => i.kind === 'keyword'));
  if (hasKeyword && !deps.hasLlm) {
    throw new LlmNotConfiguredError('批量里包含关键词条目，需要先配置 LLM');
  }
  const hasClean = groups.some((g) =>
    g.items.some((i) => i.kind === 'video' && i.naming === 'clean'),
  );
  if (hasClean && !deps.hasLlm) {
    throw new LlmNotConfiguredError('批量里有条目要清洗命名，需要先配置 LLM（或者改用原标题）');
  }
}

/**
 * List one video's parts, so a person can choose among them (0.5.1 §7.3).
 *
 * 🔴 ONE REQUEST, NOT TWO. `view` parses `pages` out of the same upstream
 * response it reads the title from, so asking `pagelist` as well would be a
 * second round trip for a list already in hand.
 *
 * NO PARTIAL SUCCESS, which is why this is not `fetchList`: a page list is one
 * response that either arrives or throws. A failure here reaches the caller as
 * an error rather than as an empty list with an explanation, because an empty
 * list would read as "this video has no parts" — a sentence that is never true.
 *
 * A single-part video answers one entry. The caller asked what the parts are.
 */
export async function fetchParts(
  client: BilibiliClient,
  bvid: string,
  options?: BiliRequestOptions,
): Promise<DownloadPartsData> {
  const view = await client.view(bvid, options);
  return {
    bvid: view.bvid,
    title: view.title,
    parts: view.pages.map((page) => ({
      page: page.page,
      part: page.part,
      // `0` is bilibili's "unknown", and a picker showing 0:00 for every part
      // is worse than one showing nothing.
      duration: page.duration > 0 ? page.duration : null,
    })),
  };
}

/**
 * Expand a favourites folder or a collection into videos.
 *
 * Partial success is the contract: a 300-video collection whose page 7 fails
 * still yields six usable pages, so `videos` carries what was fetched and
 * `error` explains why it stopped. A guardrail stopping the walk IS partial
 * success, and `error: null` would claim the opposite — the caller would show
 * the truncated list as the whole thing.
 */
export async function fetchList(
  client: BilibiliClient,
  request: FetchListRequest,
  options?: BiliRequestOptions,
): Promise<FetchListData> {
  const videos: FetchListData['videos'][number][] = [];
  let title = '';
  let error: string | null = null;
  /** True when a guardrail stopped the walk, not the list running out. */
  let truncated = false;

  try {
    if (request.type === 'favorites') {
      let page = 1;
      for (; page <= FETCH_LIST_PAGES_MAX; page++) {
        const result = await client.favoritesPage(request.media_id, page, options);
        if (title === '') title = result.title;
        videos.push(...result.videos);
        if (!result.hasMore) break;
        if (videos.length >= FETCH_LIST_ITEMS_MAX) {
          truncated = true;
          break;
        }
      }
      if (page > FETCH_LIST_PAGES_MAX) truncated = true;
    } else {
      let page = 1;
      for (; page <= FETCH_LIST_PAGES_MAX; page++) {
        const result = await client.collectionPage(request.mid, request.season_id, page, options);
        if (title === '') title = result.title;
        videos.push(...result.videos);
        if (videos.length >= result.total || result.videos.length === 0) break;
        if (videos.length >= FETCH_LIST_ITEMS_MAX) {
          truncated = true;
          break;
        }
      }
      if (page > FETCH_LIST_PAGES_MAX) truncated = true;
    }
  } catch (err) {
    // Whatever came back before the failure is still worth having.
    if (videos.length === 0) throw err;
    error = err instanceof Error ? err.message : String(err);
  }

  if (error === null && truncated) {
    error = `列表过长，只取回了前 ${videos.length} 条（上限 ${FETCH_LIST_PAGES_MAX} 页 / ${FETCH_LIST_ITEMS_MAX} 条）`;
  }

  return { title, videos: videos.slice(0, FETCH_LIST_ITEMS_MAX), error };
}

/** Turn the preflight budget's abort into the coded 504 (M3-11). */
async function withPreflightBudget<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new PreflightTimeoutError();
    }
    throw err;
  }
}
