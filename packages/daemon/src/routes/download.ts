// The download surface (M3-11).
//
// The division of labour with the engine is strict and worth stating: NETWORK
// WORK HAPPENS HERE, SCHEDULING HAPPENS THERE. Everything a request needs to
// look up before it can enqueue — expanding a short link, resolving p → cid,
// asking whether a video is multi-part — runs in the handler, outside any
// lock, and only the finished answer is handed to the engine's synchronous
// enqueue. That is what lets the engine promise "no await between a check and
// the write it justifies".
//
// The preflight also decides WHEN the user hears about a problem. For a single
// pasted input we can afford one page-list call, so a multi-part video with no
// `?p=` and no LLM is a 400 with a fix in it. Batch items skip it — 300 page
// lists is not a request budget — and fail asynchronously instead. That
// trade-off is deliberate and written down in the plan (fourth review ②):
// synchronous answers, a bounded preflight, and working without an LLM are
// three promises, and only two of them fit at once.

import {
  type DownloadTarget,
  type ParsedInput,
  PreflightTimeoutError,
  isLlmConfigured,
  parseSongInput,
  resolveLlmConfig,
} from '@lark/core';
import {
  API_PATHS,
  DOWNLOAD_BATCH_GROUPS_MAX,
  DOWNLOAD_BATCH_ITEMS_MAX,
  DOWNLOAD_BATCH_KEYWORD_MAX,
  DOWNLOAD_INPUT_MAX,
  DOWNLOAD_PARSE_LINES_MAX,
  DOWNLOAD_PLAYLIST_NAME_MAX,
  type DownloadBatchGroupInput,
  type DownloadBatchItemInput,
  type DownloadTaskAcceptedData,
  FETCH_LIST_ITEMS_MAX,
  FETCH_LIST_PAGES_MAX,
  type FetchListData,
  type ParsedItem,
  apiPath,
} from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ok } from '../response.js';
import {
  InvalidRequestError,
  objectBody,
  optionalUuid,
  pathUuid,
  requiredString,
  requiredTarget,
  requiredUuid,
} from '../validation.js';

// Input guardrails (M3-11). Not product limits — bounds on one request's work.
// The numbers live in `@lark/shared` since M6: the CLI splits a pasted file
// into requests that fit, and it can only do that against the same constants
// the daemon rejects on (M6-11).
const INPUT_MAX = DOWNLOAD_INPUT_MAX;
const PARSE_LINES_MAX = DOWNLOAD_PARSE_LINES_MAX;
const BATCH_GROUPS_MAX = DOWNLOAD_BATCH_GROUPS_MAX;
const BATCH_ITEMS_MAX = DOWNLOAD_BATCH_ITEMS_MAX;
const PLAYLIST_NAME_MAX = DOWNLOAD_PLAYLIST_NAME_MAX;

export function registerDownloadRoutes(app: FastifyInstance, ctx: AppContext): void {
  const bilibili = ctx.bilibili;

  /**
   * One deadline for a whole request's preflight, composed with shutdown.
   *
   * Per-call timeouts would let a 30-item paste spend 30 × 15s before the
   * client gave up; and without the shutdown signal `server.close()` would
   * wait out whichever is longest.
   */
  const preflightSignal = (): AbortSignal =>
    AbortSignal.any([ctx.shutdownSignal, AbortSignal.timeout(60_000)]);

  const llm = () => resolveLlmConfig(ctx.config);
  const hasLlm = () => isLlmConfigured(llm());

  /** Expand a short link if there is one, and reject anything not bilibili. */
  const resolveOne = async (input: string): Promise<ParsedItem> => {
    const parsed: ParsedInput = parseSongInput(input);
    if (parsed.kind !== 'short_link') return parsed;
    const target = await bilibili.expandShortLink(parsed.url, { signal: preflightSignal() });
    const expanded = parseSongInput(target);
    if (expanded.kind === 'short_link') {
      throw new InvalidRequestError('INVALID_SOURCE', `短链 ${parsed.url} 展开后仍是短链`);
    }
    return expanded;
  };

  /**
   * The single-input preflight: everything that can be answered before the
   * queue, answered before the queue.
   */
  const preflightSingle = async (item: ParsedItem): Promise<DownloadTarget> => {
    if (item.kind === 'keyword') {
      if (!hasLlm()) {
        throw new InvalidRequestError(
          'LLM_NOT_CONFIGURED',
          '关键词搜索需要配置 LLM；或者直接粘贴 B 站视频链接',
        );
      }
      return { kind: 'keyword', query: item.query };
    }
    if (item.kind !== 'video') {
      throw new InvalidRequestError(
        'INVALID_SOURCE',
        '收藏夹和合集链接请先用 /download/fetch-list 展开，再用 /download/batch 下载',
      );
    }
    // The page list is needed for p → cid anyway, so asking it here is free —
    // and it is the only way to know whether the LLM will be required.
    if (item.page === null) {
      const pages = await withPreflightBudget(() =>
        bilibili.pagelist(item.bvid, { signal: preflightSignal() }),
      );
      if (pages.length > 1 && !hasLlm()) {
        throw new InvalidRequestError(
          'LLM_NOT_CONFIGURED',
          `这个视频有 ${pages.length} 个分P：在链接后加 ?p=<编号>，或配置 LLM 让它自动选集`,
        );
      }
    }
    return { kind: 'video', bvid: item.bvid, page: item.page, title: null };
  };

  // ─── POST /download/song ───────────────────────────────

  app.post(API_PATHS.downloadSong, async (req, reply) => {
    const body = objectBody(req.body, ['input', 'playlist_id']);
    const input = requiredString(body, 'input', { maxLength: INPUT_MAX });
    const playlistId = optionalUuid(body, 'playlist_id');

    const item = await resolveOne(input);
    const target = await preflightSingle(item);
    const task = ctx.downloads.enqueueDownload({
      target,
      ...(playlistId === undefined ? {} : { playlistIds: [playlistId] }),
      ...(item.kind === 'video' ? { url: item.url } : {}),
    });
    ok(reply, { task_id: task.id } satisfies DownloadTaskAcceptedData, 'download queued');
  });

  // ─── POST /download/parse ──────────────────────────────

  /** Pure preview: recognises what was pasted and queues nothing. */
  app.post(API_PATHS.downloadParse, async (req, reply) => {
    const body = objectBody(req.body, ['input']);
    const input = requiredString(body, 'input', { maxLength: INPUT_MAX });
    const lines = input
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (lines.length > PARSE_LINES_MAX) {
      throw new InvalidRequestError('INVALID_BODY', `一次最多解析 ${PARSE_LINES_MAX} 行`);
    }

    const items: ParsedItem[] = [];
    for (const line of lines) items.push(await resolveOne(line));
    ok(reply, { items });
  });

  // ─── POST /download/batch ──────────────────────────────

  app.post(API_PATHS.downloadBatch, async (req, reply) => {
    const groups = readBatchGroups(req.body);
    // Keyword items need the LLM, and that is knowable with no network at all
    // — so it is still a synchronous 400 even in a batch.
    const needsLlm = groups.some((g) => g.items.some((i) => i.kind === 'keyword'));
    if (needsLlm && !hasLlm()) {
      throw new InvalidRequestError('LLM_NOT_CONFIGURED', '批量里包含关键词条目，需要先配置 LLM');
    }

    const batches = ctx.downloads.enqueueBatches(groups);
    // A `{kind:'new'}` group created a playlist, and the route is the only
    // place that knows synchronously (M3-6).
    if (groups.some((g) => g.target.kind === 'new')) {
      ctx.eventsBus.emit({ type: 'playlists:changed' });
    }
    ok(reply, { batches }, `queued ${batches.reduce((n, b) => n + b.total, 0)} items`);
  });

  // ─── POST /download/fetch-list ─────────────────────────

  /**
   * Expand a favourites folder or a collection into videos.
   *
   * Partial success is the contract: a 300-video collection whose page 7 fails
   * still yields six usable pages, so what was fetched comes back with an
   * `error` explaining why it stopped.
   */
  app.post(API_PATHS.downloadFetchList, async (req, reply) => {
    const body = objectBody(req.body, ['type', 'media_id', 'mid', 'season_id']);
    const type = requiredString(body, 'type', { maxLength: 32 });
    const signal = preflightSignal();

    const videos: FetchListData['videos'][number][] = [];
    let title = '';
    let error: string | null = null;
    /** True when a guardrail stopped the walk, not the list running out. */
    let truncated = false;

    try {
      if (type === 'favorites') {
        const mediaId = requiredNumericString(body, 'media_id');
        let page = 1;
        for (; page <= FETCH_LIST_PAGES_MAX; page++) {
          const result = await bilibili.favoritesPage(mediaId, page, { signal });
          if (title === '') title = result.title;
          videos.push(...result.videos);
          if (!result.hasMore) break;
          if (videos.length >= FETCH_LIST_ITEMS_MAX) {
            truncated = true;
            break;
          }
        }
        if (page > FETCH_LIST_PAGES_MAX) truncated = true;
      } else if (type === 'collection') {
        const mid = requiredNumericString(body, 'mid');
        const seasonId = requiredNumericString(body, 'season_id');
        let page = 1;
        for (; page <= FETCH_LIST_PAGES_MAX; page++) {
          const result = await bilibili.collectionPage(mid, seasonId, page, { signal });
          if (title === '') title = result.title;
          videos.push(...result.videos);
          if (videos.length >= result.total || result.videos.length === 0) break;
          if (videos.length >= FETCH_LIST_ITEMS_MAX) {
            truncated = true;
            break;
          }
        }
        if (page > FETCH_LIST_PAGES_MAX) truncated = true;
      } else {
        throw new InvalidRequestError('INVALID_BODY', "type must be 'favorites' or 'collection'");
      }
    } catch (err) {
      if (err instanceof InvalidRequestError) throw err;
      // Whatever came back before the failure is still worth having.
      if (videos.length === 0) throw err;
      error = err instanceof Error ? err.message : String(err);
    }

    // A guardrail stopping the walk IS partial success, and `error: null` would
    // claim the opposite — the caller would show 903 of 953 as the whole list.
    if (error === null && truncated) {
      error = `列表过长，只取回了前 ${videos.length} 条（上限 ${FETCH_LIST_PAGES_MAX} 页 / ${FETCH_LIST_ITEMS_MAX} 条）`;
    }

    ok(reply, {
      title,
      videos: videos.slice(0, FETCH_LIST_ITEMS_MAX),
      error,
    } satisfies FetchListData);
  });

  // ─── POST /download/cancel ─────────────────────────────

  app.post(API_PATHS.downloadCancel, async (req, reply) => {
    const body = objectBody(req.body, ['task_id']);
    const task = ctx.downloads.cancel(requiredUuid(body, 'task_id'));
    ok(reply, task, `task is ${task.state}`);
  });

  // ─── GET /download/tasks ───────────────────────────────

  app.get(API_PATHS.downloadTasks, async (_req, reply) => {
    ok(reply, ctx.downloads.snapshot());
  });

  // ─── POST /download/lyrics/:id ─────────────────────────

  app.post(apiPath.downloadLyrics(':id'), async (req, reply) => {
    const id = pathUuid((req.params as { id: string }).id);
    const task = ctx.downloads.enqueueLyrics(id);
    ok(reply, { task_id: task.id } satisfies DownloadTaskAcceptedData, 'lyrics fetch queued');
  });
}

// ─── Body readers ──────────────────────────────────────

/** ids in bilibili list URLs are decimal strings, and stay strings (they overflow). */
function requiredNumericString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new InvalidRequestError('INVALID_BODY', `${key} must be a numeric id string`);
  }
  return value;
}

function readBatchGroups(raw: unknown): DownloadBatchGroupInput[] {
  const body = objectBody(raw, ['groups']);
  const groups = body.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new InvalidRequestError('INVALID_BODY', 'groups must be a non-empty array');
  }
  if (groups.length > BATCH_GROUPS_MAX) {
    throw new InvalidRequestError('INVALID_BODY', `at most ${BATCH_GROUPS_MAX} groups per request`);
  }

  let total = 0;
  const out: DownloadBatchGroupInput[] = [];
  for (const entry of groups) {
    const group = objectBody(entry, ['target', 'items']);
    const items = group.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw new InvalidRequestError('INVALID_BODY', 'each group needs a non-empty items array');
    }
    total += items.length;
    if (total > BATCH_ITEMS_MAX) {
      throw new InvalidRequestError('INVALID_BODY', `at most ${BATCH_ITEMS_MAX} items per request`);
    }
    out.push({
      target: requiredTarget(group.target, PLAYLIST_NAME_MAX),
      items: items.map(readItem),
    });
  }
  return out;
}

function readItem(raw: unknown): DownloadBatchItemInput {
  const item = objectBody(raw, ['kind', 'bvid', 'page', 'title', 'query']);
  if (item.kind === 'keyword') {
    return {
      kind: 'keyword',
      query: requiredString(item, 'query', { maxLength: DOWNLOAD_BATCH_KEYWORD_MAX }),
    };
  }
  if (item.kind !== 'video') {
    throw new InvalidRequestError('INVALID_BODY', "item.kind must be 'video' or 'keyword'");
  }
  // Validated through the same parser the paste box uses, so a batch cannot
  // smuggle in an id shape a URL could not.
  const parsed = parseSongInput(requiredString(item, 'bvid', { maxLength: 32 }));
  if (parsed.kind !== 'video') {
    throw new InvalidRequestError('INVALID_BODY', 'item.bvid must be a BV id');
  }
  const page = item.page;
  if (page !== null && page !== undefined) {
    if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1) {
      throw new InvalidRequestError('INVALID_BODY', 'item.page must be a positive integer or null');
    }
  }
  const title = item.title;
  if (title !== null && title !== undefined && typeof title !== 'string') {
    throw new InvalidRequestError('INVALID_BODY', 'item.title must be a string or null');
  }
  return {
    kind: 'video',
    bvid: parsed.bvid,
    page: typeof page === 'number' ? page : null,
    title: typeof title === 'string' && title.trim() !== '' ? title.trim() : null,
  };
}

/** Turn the preflight budget's abort into the documented 504 (M3-11). */
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
