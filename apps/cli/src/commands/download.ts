// `lark download` and `lark songs redownload` (M6-11).
//
// One command covers three shapes because the user cannot be expected to know
// which one they pasted:
//
//   one link / keyword          → one task, followed to the end by default
//   a favourites / collection   → expand it, show what is in it, ask, enqueue
//   many lines (`--batch`)      → one batch, `--wait` optional
//
// `POST /download/parse` is what decides which: it recognises and expands
// short links and enqueues NOTHING, so the classification costs no queue
// entries and no partial state. Everything local — line length, the item cap,
// keyword length — is checked before that call, against the constants the
// daemon rejects on (`@lark/shared`), so a bad paste is a fast, precise
// refusal rather than an `INVALID_BODY` about a request the user never wrote.
//
// A batch always asks first. A 953-video favourites folder is not something to
// start on a typo, and the confirmation rules are the shared ones: a TTY gets
// a question, everything else needs `--yes` (M6-6).

import {
  type ApiResponse,
  type BatchTargetInput,
  DOWNLOAD_BATCH_ITEMS_MAX,
  DOWNLOAD_BATCH_KEYWORD_MAX,
  type DownloadBatchData,
  type DownloadBatchGroupInput,
  type DownloadBatchItemInput,
  type DownloadBatchesData,
  type DownloadNamingMode,
  type DownloadSongRequest,
  type DownloadTaskAcceptedData,
  type DownloadTaskData,
  type FetchListData,
  type FetchListRequest,
  type ParsedItem,
  VIRTUAL_ALL_PLAYLIST_ID,
} from '@lark/shared';
import type { CommandContext } from '../context.js';
import { confirm } from '../lib/confirm.js';
import {
  type InputLine,
  chunkForParse,
  collectLines,
  describeLines,
  precheckLines,
  readBatchLines,
} from '../lib/download-input.js';
import { CliError, usageError } from '../lib/errors.js';
import { emitEnvelope, successEnvelope } from '../lib/output.js';
import { resolvePlaylistRef, resolveSongRef } from '../lib/resolve-ref.js';
import { type WaitDeps, waitForBatch, waitForTask } from '../lib/wait.js';

export interface DownloadOptions {
  batch?: string;
  playlist?: string;
  /** Tri-state: absent means "the default for this shape" (M6-11). */
  wait?: boolean;
  allowPartial?: boolean;
  /** `--clean-name`: let the LLM name the song instead of keeping the title. */
  cleanName?: boolean;
}

/** Injected so tests need neither a clock nor a real stdin. */
export interface DownloadDeps extends WaitDeps {
  stdin?: AsyncIterable<Uint8Array | string>;
}

/** What `--clean-name` means for a video item (§3.6-1). */
function namingOf(opts: DownloadOptions): DownloadNamingMode {
  return opts.cleanName === true ? 'clean' : 'original';
}

/**
 * Whether these arguments make a command at all — decided WITHOUT a backend.
 *
 * The registry runs this before the daemon is probed, so `lark download` with
 * nothing to download is a usage error (exit 2) rather than "no daemon"
 * (exit 4): the second answer would send the user off to start a daemon that
 * would refuse the same command for the same reason.
 */
export function assertDownloadShape(input: string | undefined, opts: DownloadOptions): void {
  if (input !== undefined && opts.batch !== undefined) {
    throw usageError('<input> 和 --batch 只能给一个：--batch 从文件（或 `-` 标准输入）逐行读。');
  }
  if (input === undefined && opts.batch === undefined) {
    throw usageError('给一个链接或关键词，或者用 --batch <文件|-> 批量下载。');
  }
}

export async function runDownload(
  ctx: CommandContext,
  input: string | undefined,
  opts: DownloadOptions,
  deps: DownloadDeps = {},
): Promise<void> {
  assertDownloadShape(input, opts);

  const lines =
    opts.batch === undefined
      ? collectLines(input as string)
      : await readBatchLines(opts.batch, deps.stdin === undefined ? {} : { stdin: deps.stdin });
  precheckLines(lines);

  const items = await parseAll(ctx, lines);

  // A list link is its own flow, and only on its own: expanding two folders
  // into one batch hides which one a failure came from.
  const only = lines.length === 1 ? items[0] : undefined;
  if (only !== undefined && (only.kind === 'favorites' || only.kind === 'collection')) {
    return await downloadList(ctx, only, opts, deps);
  }
  if (lines.length === 1) {
    return await downloadOne(ctx, (lines[0] as InputLine).text, only as ParsedItem, opts, deps);
  }
  return await downloadMany(ctx, lines, items, opts, deps);
}

/**
 * Classify every line, in requests that fit.
 *
 * The daemon answers one item per line, in order, and the alignment is what
 * lets a refusal name a line number — so a response of the wrong length is a
 * protocol failure, not something to soldier on with.
 */
async function parseAll(ctx: CommandContext, lines: readonly InputLine[]): Promise<ParsedItem[]> {
  const items: ParsedItem[] = [];
  for (const chunk of chunkForParse(lines)) {
    const envelope = await ctx.backend.parseInput(chunk.map((line) => line.text).join('\n'));
    const parsed = envelope.data?.items ?? [];
    if (parsed.length !== chunk.length) {
      throw new CliError(
        'INVALID_RESPONSE',
        `daemon 的解析结果与输入对不上（发送 ${chunk.length} 行，返回 ${parsed.length} 条）。`,
      );
    }
    items.push(...parsed);
  }
  return items;
}

// ─── One input ─────────────────────────────────────────

async function downloadOne(
  ctx: CommandContext,
  input: string,
  item: ParsedItem,
  opts: DownloadOptions,
  deps: DownloadDeps,
): Promise<void> {
  // A keyword search has no title to keep, so it is named by the model either
  // way — and the daemon refuses `naming_mode` on one. Saying so beats sending
  // the flag and letting it be ignored (the `--allow-partial` lesson, F11).
  if (item.kind === 'keyword' && opts.cleanName === true) {
    throw usageError('--clean-name 只对视频链接有意义：关键词搜索的命名一直由 LLM 决定。');
  }
  const target = await resolveTarget(ctx, opts.playlist);
  const request: DownloadSongRequest = { input };
  if (item.kind === 'video') request.naming_mode = namingOf(opts);
  if (target.target.kind === 'playlist') request.playlist_id = target.target.playlist_id;

  const envelope = await ctx.backend.downloadSong(request);
  // A single input is followed by default: the user typed one thing and is
  // waiting to hear how it went.
  await followTask(ctx, envelope, opts.wait !== false, deps);
}

/**
 * Queue-and-maybe-wait, shared with `songs redownload` and `lyrics redownload`.
 *
 * Without `--wait` the daemon's acceptance envelope is printed VERBATIM (it is
 * what the daemon said); with it, the terminal task snapshot replaces it.
 */
export async function followTask(
  ctx: CommandContext,
  accepted: ApiResponse<DownloadTaskAcceptedData>,
  wait: boolean,
  deps: WaitDeps,
): Promise<void> {
  const taskId = (accepted.data as DownloadTaskAcceptedData).task_id;
  if (!wait) {
    if (ctx.flags.json) return emitEnvelope(ctx.streams, accepted);
    return ctx.streams.out(`✓ 已加入队列（task ${taskId}）`);
  }

  const task = await waitForTask(ctx, taskId, deps);
  reportTask(ctx, task);
}

/**
 * A finished task, as an outcome.
 *
 * A failed download exits non-zero, which under the output contract means
 * stdout stays empty and the whole terminal snapshot travels in
 * `details.task` — so `--json` consumers still get the stage it died at and
 * the task-level `error_code`, without that code ever pretending to be an
 * envelope code (M6-6 六轮①).
 */
function reportTask(ctx: CommandContext, task: DownloadTaskData): void {
  if (task.state === 'succeeded') {
    if (ctx.flags.json) {
      emitEnvelope(ctx.streams, successEnvelope(task, { message: 'download finished' }));
      return;
    }
    const song = task.result === null ? '' : `（song ${task.result.song_id}）`;
    ctx.streams.out(`✓ 完成${song}`);
    return;
  }
  if (task.state === 'cancelled') {
    throw new CliError('TASK_CANCELLED', '任务被取消了。', { task });
  }
  throw new CliError(
    'TASK_FAILED',
    task.error_message ?? `下载失败（${task.error_code ?? '原因未知'}）`,
    { task },
  );
}

// ─── A favourites folder / a collection ────────────────

async function downloadList(
  ctx: CommandContext,
  item: Extract<ParsedItem, { kind: 'favorites' | 'collection' }>,
  opts: DownloadOptions,
  deps: DownloadDeps,
): Promise<void> {
  const request: FetchListRequest =
    item.kind === 'favorites'
      ? { type: 'favorites', media_id: item.media_id }
      : { type: 'collection', mid: item.mid, season_id: item.season_id };

  const list = (await ctx.backend.fetchList(request)).data as FetchListData;

  // Partial success is the daemon's contract, not an accident — but it is the
  // user's call whether "the first 903 of 953" is what they wanted.
  if (list.error !== null && opts.allowPartial !== true) {
    throw new CliError(
      'BILIBILI_FAILED',
      `列表没有取全（已取回 ${list.videos.length} 条）：${list.error}\n确认这样也行的话，加 --allow-partial 重试。`,
      { fetched: list.videos.length, error: list.error },
    );
  }
  if (list.videos.length === 0) {
    throw new CliError('NOT_FOUND', '这个列表里没有可下载的视频。');
  }
  if (list.videos.length > DOWNLOAD_BATCH_ITEMS_MAX) {
    throw new CliError(
      'LIST_TOO_LARGE',
      `列表有 ${list.videos.length} 条，一次最多 ${DOWNLOAD_BATCH_ITEMS_MAX} 条——用 GUI 分批，或先把列表拆开。`,
      { count: list.videos.length },
    );
  }

  const target = await resolveTarget(ctx, opts.playlist);
  if (!ctx.flags.json) {
    ctx.streams.out(`列表：${list.title === '' ? '(未命名)' : list.title}`);
    ctx.streams.out(`视频：${list.videos.length} 个`);
    if (list.error !== null) ctx.streams.out(`注意：${list.error}`);
    ctx.streams.out(`目标：${target.label}`);
  }
  await confirm(`下载这 ${list.videos.length} 个视频？`, {
    yes: ctx.flags.yes,
    json: ctx.flags.json,
  });

  const items: DownloadBatchItemInput[] = list.videos.map((video) => ({
    kind: 'video',
    bvid: video.bvid,
    // A list gives no `?p=`, and its title is the trustworthy one (M3-5) —
    // which is also what `clean` hands the model to read a song name out of.
    page: null,
    title: video.title,
    naming: namingOf(opts),
  }));
  await enqueueBatch(ctx, [{ target: target.target, items }], opts, deps);
}

// ─── Many lines ────────────────────────────────────────

async function downloadMany(
  ctx: CommandContext,
  lines: readonly InputLine[],
  items: readonly ParsedItem[],
  opts: DownloadOptions,
  deps: DownloadDeps,
): Promise<void> {
  const listLines = lines.filter((_line, index) => {
    const kind = (items[index] as ParsedItem).kind;
    return kind === 'favorites' || kind === 'collection';
  });
  if (listLines.length > 0) {
    throw usageError(
      `${describeLines(listLines)}是收藏夹 / 合集链接：它们要单独下载（一次一个列表）。`,
      { lines: listLines.map((line) => line.line) },
    );
  }

  // The keyword cap is the batch route's, and it is checked HERE — after the
  // parse that says which lines are keywords — so a 600-character URL is not
  // mistaken for an over-long keyword.
  const longKeywords = lines.filter((_line, index) => {
    const item = items[index] as ParsedItem;
    return item.kind === 'keyword' && item.query.length > DOWNLOAD_BATCH_KEYWORD_MAX;
  });
  if (longKeywords.length > 0) {
    throw usageError(
      `${describeLines(longKeywords)}的关键词超过 ${DOWNLOAD_BATCH_KEYWORD_MAX} 个字符。`,
      { lines: longKeywords.map((line) => line.line) },
    );
  }

  const batchItems: DownloadBatchItemInput[] = items.map((item) =>
    item.kind === 'keyword'
      ? { kind: 'keyword', query: item.query }
      : {
          kind: 'video',
          bvid: (item as { bvid: string }).bvid,
          page: pageOf(item),
          title: null,
          naming: namingOf(opts),
        },
  );

  const target = await resolveTarget(ctx, opts.playlist);
  if (!ctx.flags.json) {
    const keywords = batchItems.filter((item) => item.kind === 'keyword').length;
    const videos = batchItems.length - keywords;
    ctx.streams.out(`共 ${batchItems.length} 条：视频 ${videos}，关键词 ${keywords}`);
    ctx.streams.out(`目标：${target.label}`);
  }
  await confirm(`下载这 ${batchItems.length} 条？`, { yes: ctx.flags.yes, json: ctx.flags.json });

  await enqueueBatch(ctx, [{ target: target.target, items: batchItems }], opts, deps);
}

function pageOf(item: ParsedItem): number | null {
  return item.kind === 'video' ? item.page : null;
}

// ─── Batch enqueue and outcome ─────────────────────────

async function enqueueBatch(
  ctx: CommandContext,
  groups: readonly DownloadBatchGroupInput[],
  opts: DownloadOptions,
  deps: DownloadDeps,
): Promise<void> {
  const envelope = await ctx.backend.downloadBatch(groups);
  const batches = (envelope.data as DownloadBatchesData).batches;
  const total = batches.reduce((sum, batch) => sum + batch.total, 0);

  // Unlike a single input, a batch does NOT wait by default: enqueuing 300
  // videos and holding the terminal for the next hour is not what most callers
  // want, and the queue survives the CLI exiting.
  if (opts.wait !== true) {
    if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);
    return ctx.streams.out(
      `✓ 已加入队列：${total} 条（批次 ${batches.map((b) => b.id).join(' ')}）`,
    );
  }

  // The CLI always sends exactly one group, so there is exactly one batch.
  const batch = batches[0];
  if (batch === undefined) {
    throw new CliError('INVALID_RESPONSE', 'daemon 没有返回批次，无法跟踪。');
  }
  reportBatch(ctx, await waitForBatch(ctx, batch.id, deps));
}

function reportBatch(ctx: CommandContext, batch: DownloadBatchData): void {
  const failed = batch.items.filter((item) => item.final?.state !== 'succeeded');
  if (failed.length === 0) {
    if (ctx.flags.json) {
      emitEnvelope(ctx.streams, successEnvelope(batch, { message: 'batch finished' }));
      return;
    }
    ctx.streams.out(`✓ ${batch.items.length} 条全部完成`);
    return;
  }

  // Per item there is only ever an `error_code` — `BatchItemFinal` carries no
  // message and the wire contract is not being widened for this (M6-11 六轮①).
  const detail = failed
    .map((item) => `#${item.index + 1} ${item.final?.error_code ?? item.final?.state ?? '未完成'}`)
    .join('、');
  throw new CliError(
    'BATCH_PARTIAL_FAILURE',
    `${batch.items.length} 条里有 ${failed.length} 条没成功：${detail}`,
    { batch },
  );
}

// ─── Target ────────────────────────────────────────────

interface ResolvedTarget {
  target: BatchTargetInput;
  label: string;
}

/** One target for the whole command; absent (or `all`) means library-only. */
async function resolveTarget(
  ctx: CommandContext,
  ref: string | undefined,
): Promise<ResolvedTarget> {
  const library: ResolvedTarget = { target: { kind: 'all' }, label: '整个曲库（不进歌单）' };
  if (ref === undefined) return library;

  const id = await resolvePlaylistRef(ctx.backend, ref, { allowAll: true });
  if (id === VIRTUAL_ALL_PLAYLIST_ID) return library;
  return { target: { kind: 'playlist', playlist_id: id }, label: `歌单「${ref}」` };
}

// ─── songs redownload ──────────────────────────────────

export interface WaitOption {
  wait?: boolean;
}

/** Force a fresh fetch of a song's audio, replacing whatever is on disk. */
export async function runSongsRedownload(
  ctx: CommandContext,
  ref: string,
  opts: WaitOption,
  deps: WaitDeps = {},
): Promise<void> {
  const id = await resolveSongRef(ctx.backend, ref);
  await followTask(ctx, await ctx.backend.redownloadSong(id), opts.wait !== false, deps);
}
