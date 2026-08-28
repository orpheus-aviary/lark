// The download surface (M3-11), a thin shell over the portable preflight (N4a).
//
// The division of labour with the engine is strict and worth stating: NETWORK
// WORK HAPPENS HERE, SCHEDULING HAPPENS THERE. Everything a request needs to
// look up before it can enqueue — expanding a short link, resolving p → cid,
// asking whether a video is multi-part — runs in the handler, outside any
// lock, and only the finished answer is handed to the engine's synchronous
// enqueue. That is what lets the engine promise "no await between a check and
// the write it justifies".
//
// The JUDGEMENTS behind those look-ups (which failures are synchronous, when
// the LLM is required, what a list link gets refused with) moved to
// `@lark/core`'s `preflight` in N4a, so the phone reaches the same verdicts
// through the same code. What stays here is REQUEST SHAPE: reading the body,
// the two `naming_mode` rules that describe the request rather than the
// download, and composing the preflight deadline with shutdown (§2.4).
//
// The preflight also decides WHEN the user hears about a problem. For a single
// pasted input we can afford one page-list call, so a multi-part video with no
// `?p=` and no LLM is a 400 with a fix in it. Batch items skip it — 300 page
// lists is not a request budget — and fail asynchronously instead.

import {
  fetchList,
  isLlmConfigured,
  parseSongInput,
  preflightBatch,
  preflightSingle,
  resolveLlmConfig,
  resolveOne,
} from '@lark/core';
import {
  API_PATHS,
  DOWNLOAD_BATCH_GROUPS_MAX,
  DOWNLOAD_BATCH_ITEMS_MAX,
  DOWNLOAD_BATCH_KEYWORD_MAX,
  DOWNLOAD_INPUT_MAX,
  DOWNLOAD_LIST_KINDS,
  DOWNLOAD_NAMING_MODES,
  DOWNLOAD_PARSE_LINES_MAX,
  DOWNLOAD_PLAYLIST_NAME_MAX,
  DOWNLOAD_SOURCE_TITLE_MAX,
  DOWNLOAD_SOURCE_URL_MAX,
  type DownloadBatchGroupInput,
  type DownloadBatchItemInput,
  type DownloadCancelAllData,
  type DownloadListKind,
  type DownloadNamingMode,
  type DownloadTaskAcceptedData,
  type FetchListRequest,
  type ParsedItem,
  apiPath,
} from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ok } from '../response.js';
import {
  InvalidRequestError,
  objectBody,
  optionalEnum,
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
  const deps = () => ({ client: bilibili, hasLlm: hasLlm() });

  /**
   * The two `naming_mode` rules that are about REQUEST SHAPE, not feasibility
   * (§2.4). A keyword has no title to keep, so a caller that names one is wrong
   * about what it is asking for; a video has a title, so a mode is required to
   * say whether to keep it. Both are INVALID_BODY, and both stay here because
   * the phone never sends either shape — only a hand-formed HTTP request can.
   */
  const assertNamingShape = (
    item: ParsedItem,
    namingMode: DownloadNamingMode | undefined,
  ): void => {
    if (item.kind === 'keyword' && namingMode !== undefined) {
      throw new InvalidRequestError(
        'INVALID_BODY',
        'naming_mode 只用于视频链接：关键词搜索的命名一直由 LLM 决定',
      );
    }
    if (item.kind === 'video' && namingMode === undefined) {
      throw new InvalidRequestError(
        'INVALID_BODY',
        'naming_mode 必填（original = 原标题，clean = 让 LLM 提取歌名和歌手）',
      );
    }
  };

  // ─── POST /download/song ───────────────────────────────

  app.post(API_PATHS.downloadSong, async (req, reply) => {
    const body = objectBody(req.body, ['input', 'playlist_id', 'naming_mode']);
    const input = requiredString(body, 'input', { maxLength: INPUT_MAX });
    const playlistId = optionalUuid(body, 'playlist_id');
    const namingMode = optionalEnum(body, 'naming_mode', DOWNLOAD_NAMING_MODES);

    const item = await resolveOne(bilibili, input, { signal: preflightSignal() });
    assertNamingShape(item, namingMode);
    const target = await preflightSingle(deps(), item, namingMode, { signal: preflightSignal() });
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
    for (const line of lines)
      items.push(await resolveOne(bilibili, line, { signal: preflightSignal() }));
    ok(reply, { items });
  });

  // ─── POST /download/batch ──────────────────────────────

  app.post(API_PATHS.downloadBatch, async (req, reply) => {
    const groups = readBatchGroups(req.body);
    // Keyword and `clean` items need the LLM, and that is knowable with no
    // network at all — so it stays a synchronous 400 even in a batch.
    preflightBatch(deps(), groups);

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
   * Expand a favourites folder or a collection into videos. The walk, the
   * caps and the partial-success semantics are in `@lark/core`'s `fetchList`;
   * the route reads the body into the discriminated request it takes.
   */
  app.post(API_PATHS.downloadFetchList, async (req, reply) => {
    const request = readFetchListRequest(req.body);
    const data = await fetchList(bilibili, request, { signal: preflightSignal() });
    ok(reply, data);
  });

  // ─── POST /download/cancel ─────────────────────────────

  app.post(API_PATHS.downloadCancel, async (req, reply) => {
    const body = objectBody(req.body, ['task_id']);
    const task = ctx.downloads.cancel(requiredUuid(body, 'task_id'));
    ok(reply, task, `task is ${task.state}`);
  });

  // ─── POST /download/cancel-all ─────────────────────────

  /**
   * Ask every active task to stop (§4-f).
   *
   * The active set is SNAPSHOTTED first: cancelling releases the worker, which
   * starts the next queued task, and a loop reading the live list would chase
   * its own tail. Per-item because the outcomes differ — queued stops now,
   * running is asked and answers `running`, and one past the commit point
   * cannot be cancelled at all and says so instead of failing the request.
   */
  app.post(API_PATHS.downloadCancelAll, async (_req, reply) => {
    const active = ctx.downloads
      .snapshot()
      .tasks.filter((task) => task.state === 'queued' || task.state === 'running');

    const results = active.map((task) => {
      try {
        const after = ctx.downloads.cancel(task.id);
        return { task_id: task.id, state: after.state, error_code: null };
      } catch (err) {
        // One task refusing is not the request failing: the other nineteen
        // still stopped, and the caller is told which one did not.
        const code = (err as { code?: string }).code ?? 'INTERNAL_ERROR';
        return { task_id: task.id, state: task.state, error_code: code };
      }
    });

    const cancelled = results.filter((result) => result.state === 'cancelled').length;
    ok(reply, { cancelled, results } satisfies DownloadCancelAllData, `cancelled ${cancelled}`);
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

/**
 * Read the fetch-list body into the discriminated request `fetchList` takes.
 *
 * The union is the contract (fifth review ⑦): each kind carries its own ids,
 * and a missing one is a 400 here rather than a confusing upstream error.
 */
function readFetchListRequest(raw: unknown): FetchListRequest {
  const body = objectBody(raw, ['type', 'media_id', 'mid', 'season_id']);
  const type = requiredString(body, 'type', { maxLength: 32 });
  if (type === 'favorites') {
    return { type: 'favorites', media_id: requiredNumericString(body, 'media_id') };
  }
  if (type === 'collection') {
    return {
      type: 'collection',
      mid: requiredNumericString(body, 'mid'),
      season_id: requiredNumericString(body, 'season_id'),
    };
  }
  throw new InvalidRequestError('INVALID_BODY', "type must be 'favorites' or 'collection'");
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
    const group = objectBody(entry, ['target', 'items', 'source']);
    const items = group.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw new InvalidRequestError('INVALID_BODY', 'each group needs a non-empty items array');
    }
    total += items.length;
    if (total > BATCH_ITEMS_MAX) {
      throw new InvalidRequestError('INVALID_BODY', `at most ${BATCH_ITEMS_MAX} items per request`);
    }
    const source = readGroupSource(group.source);
    out.push({
      target: requiredTarget(group.target, PLAYLIST_NAME_MAX),
      items: items.map(readItem),
      ...(source === undefined ? {} : { source }),
    });
  }
  return out;
}

/**
 * The list a group came from, when it came from one (④).
 *
 * ABSENT IS LEGAL, and that is the shape rather than a leniency: a group of
 * pasted links or keywords has no list identity, and every client sends those.
 * Present-but-wrong is a 400 like any other body — this string is copied onto
 * every task in the group and then repeated in a download record for as long
 * as somebody keeps it, so it is not a field to be relaxed about.
 */
function readGroupSource(raw: unknown): DownloadBatchGroupInput['source'] {
  if (raw === undefined || raw === null) return undefined;
  const source = objectBody(raw, ['list', 'title', 'url']);
  // Checked here rather than through `optionalEnum`, whose message names the
  // key alone — and this body has other `kind`-ish fields to confuse it with.
  // A 400 is only useful if it says WHICH one.
  const list = source.list;
  if (!DOWNLOAD_LIST_KINDS.includes(list as DownloadListKind)) {
    throw new InvalidRequestError(
      'INVALID_BODY',
      `source.list must be one of: ${DOWNLOAD_LIST_KINDS.join(', ')}`,
    );
  }
  return {
    list: list as DownloadListKind,
    title: requiredString(source, 'title', { maxLength: DOWNLOAD_SOURCE_TITLE_MAX }),
    url: requiredString(source, 'url', { maxLength: DOWNLOAD_SOURCE_URL_MAX }),
  };
}

function readItem(raw: unknown): DownloadBatchItemInput {
  const item = objectBody(raw, ['kind', 'bvid', 'page', 'title', 'query', 'naming']);
  if (item.kind === 'keyword') {
    // Refused rather than ignored: `naming` on a keyword item is a caller that
    // believes it is choosing something (§3.6-1). `objectBody` has to allow the
    // key for the video branch, so this is the only place that can say no.
    if (item.naming !== undefined) {
      throw new InvalidRequestError('INVALID_BODY', 'keyword 条目不接受 naming');
    }
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
  const naming = optionalEnum(item, 'naming', DOWNLOAD_NAMING_MODES);
  if (naming === undefined) {
    throw new InvalidRequestError('INVALID_BODY', 'item.naming must be original or clean');
  }
  return {
    kind: 'video',
    bvid: parsed.bvid,
    page: typeof page === 'number' ? page : null,
    title: typeof title === 'string' && title.trim() !== '' ? title.trim() : null,
    naming,
  };
}
