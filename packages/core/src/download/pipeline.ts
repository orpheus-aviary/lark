// The work one task actually does, as steps the engine calls in order (M3-2).
//
// Split out of `engine.ts` on purpose: the engine is about scheduling — a
// queue, a state machine, claims — and none of that should be interleaved with
// "how do I turn a keyword into a bvid". The two halves also have opposite
// concurrency rules. Everything here is async and may take minutes; everything
// the engine does around it is synchronous and must not touch the network.
//
// Which steps need an LLM is the R16 line, drawn here:
//
//   video target, explicit or single-part  → no LLM, ever
//   stored source key that still resolves  → no LLM, ever
//   keyword                                → LLM (search + pick)
//   multi-part with no ?p=                 → LLM (pick the part)
//   stored key that no longer resolves     → LLM (re-identify), else SOURCE_GONE

import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { DownloadStage, LlmConfig, SongData } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import type { LarkDatabase } from '../db/index.js';
import { songs } from '../db/schema.js';
import { BilibiliApiError, LlmNotConfiguredError, SourceGoneError } from '../errors.js';
import { writeLyrics } from '../library/lyrics.js';
import type { MediaToolsProvider } from '../media-tools/registry.js';
import type { BiliPage, BilibiliClient } from './bilibili.js';
import { ensureMp3, probeAudio } from './ffmpeg.js';
import { type NormalizedSource, normalizeSourceOnline } from './link.js';
import { chatCompletion, cleanLlmJson } from './llm.js';
import { fetchLyrics } from './lyrics/select.js';
import type { LyricsOrigins } from './lyrics/shared.js';
import { ANALYZE_PROMPT, INFER_SONG_INFO_PROMPT, multiPPrompt, selectPrompt } from './prompts.js';
import { stagePaths } from './resolve.js';
import type { DownloadTimeouts } from './timeouts.js';

export interface PipelineDeps {
  db: LarkDatabase;
  sqlite: BetterSqlite3.Database;
  bilibili: BilibiliClient;
  /** The task's config snapshot: `null` means no LLM for this whole task. */
  llm: LlmConfig | null;
  /**
   * The process-wide media toolchain (M7-18). Not a path pair: acquiring
   * through the registry is what lets a toolchain that broke mid-session be
   * re-probed, and what makes "no ffmpeg" a `MEDIA_TOOLS_UNAVAILABLE` before
   * the download starts instead of a transcode failure after it.
   */
  mediaTools: MediaToolsProvider;
  timeouts: DownloadTimeouts;
  fetchImpl?: typeof fetch;
  lyricsOrigins?: Partial<LyricsOrigins>;
}

export interface StepContext {
  signal: AbortSignal;
  reportStage: (stage: DownloadStage) => void;
}

/** What a task is trying to download, after the route's deterministic parse. */
export type DownloadTarget =
  | { kind: 'video'; bvid: string; page: number | null; title: string | null }
  | { kind: 'keyword'; query: string };

export interface ResolvedTarget {
  source: NormalizedSource;
  /** Song name to store. Frozen: the video's own title unless a list gave one. */
  name: string;
  artist: string;
}

// ─── Target → identity ─────────────────────────────────

/**
 * Turn a target into a resolved (bvid, page, cid) plus the name to store.
 *
 * Naming is frozen (M3-7): a URL download takes the video's title and
 * uploader verbatim, and only a batch item's own `title` overrides it. The Go
 * version ran every download through `inferSongInfo`, which meant the same URL
 * could produce a different song name on different days.
 */
export async function resolveTarget(
  deps: PipelineDeps,
  target: DownloadTarget,
  ctx: StepContext,
): Promise<ResolvedTarget> {
  if (target.kind === 'keyword') return resolveKeyword(deps, target.query, ctx);

  ctx.reportStage('resolving');
  const page = await choosePage(deps, target, ctx);
  const source = await normalizeSourceOnline(
    deps.bilibili,
    { bvid: target.bvid, page },
    { signal: ctx.signal },
  );
  const view = await deps.bilibili.view(target.bvid, { signal: ctx.signal });
  return {
    source,
    name: target.title ?? view.title,
    artist: view.ownerName,
  };
}

/**
 * A multi-part video with no `?p=` is the one place a plain URL still needs
 * the model. With `?p=` — or with only one part — this never runs, which is
 * what makes "paste a link, no LLM" true.
 */
async function choosePage(
  deps: PipelineDeps,
  target: { bvid: string; page: number | null; title: string | null },
  ctx: StepContext,
): Promise<number> {
  if (target.page !== null) return target.page;
  const pages = await deps.bilibili.pagelist(target.bvid, { signal: ctx.signal });
  if (pages.length <= 1) return 1;
  if (deps.llm === null) {
    throw new LlmNotConfiguredError(
      `${target.bvid} 有 ${pages.length} 个分P：请在链接后加 ?p=<编号>，或配置 LLM 让它自动选集`,
    );
  }
  return pickPage(deps, pages, target.title ?? '', '', ctx);
}

async function pickPage(
  deps: PipelineDeps,
  pages: readonly BiliPage[],
  name: string,
  artist: string,
  ctx: StepContext,
): Promise<number> {
  const summary = pages.map((p) => ({
    page: p.page,
    part: p.part,
    duration: p.duration,
  }));
  const answer = await llm(deps, multiPPrompt(name, artist), JSON.stringify(summary, null, 2), ctx);
  const page = Number(answer.trim());
  // The prompt asks for "1" when it cannot tell, but a model that answers
  // prose must not take the task down — page 1 is the honest default.
  return Number.isInteger(page) && page >= 1 && page <= pages.length ? page : 1;
}

async function resolveKeyword(
  deps: PipelineDeps,
  query: string,
  ctx: StepContext,
): Promise<ResolvedTarget> {
  ctx.reportStage('analyzing');
  const analysis = await analyzeKeyword(deps, query, ctx);

  ctx.reportStage('searching');
  const results = await deps.bilibili.search(analysis.query, { signal: ctx.signal });
  if (results.length === 0) {
    throw new BilibiliApiError(`bilibili 上没有找到「${analysis.query}」`);
  }

  const answer = await llm(
    deps,
    selectPrompt(analysis.song_name, analysis.artist),
    JSON.stringify(results, null, 2),
    ctx,
  );
  const bvid = answer.trim();
  if (bvid === '' || bvid === 'NONE') {
    throw new BilibiliApiError(`没有与「${analysis.song_name} - ${analysis.artist}」匹配的视频`);
  }

  ctx.reportStage('resolving');
  const pages = await deps.bilibili.pagelist(bvid, { signal: ctx.signal });
  const page =
    pages.length <= 1 ? 1 : await pickPage(deps, pages, analysis.song_name, analysis.artist, ctx);
  const source = await normalizeSourceOnline(deps.bilibili, { bvid, page }, { signal: ctx.signal });

  const view = await deps.bilibili.view(bvid, { signal: ctx.signal });
  const inferred = await inferSongInfo(deps, view.title, query, view.ownerName, ctx);
  return {
    source,
    name: inferred.song_name !== '' ? inferred.song_name : view.title,
    artist: inferred.artist !== '' ? inferred.artist : view.ownerName,
  };
}

interface Analysis {
  song_name: string;
  artist: string;
  query: string;
}

async function analyzeKeyword(
  deps: PipelineDeps,
  input: string,
  ctx: StepContext,
): Promise<Analysis> {
  const parsed = await llmJson<Partial<Analysis>>(deps, ANALYZE_PROMPT, input, ctx);
  return {
    song_name: str(parsed?.song_name) || input,
    artist: str(parsed?.artist),
    // A model that drops `query` still leaves us the user's own words.
    query: str(parsed?.query) || input,
  };
}

async function inferSongInfo(
  deps: PipelineDeps,
  title: string,
  userInput: string,
  uploader: string,
  ctx: StepContext,
): Promise<{ song_name: string; artist: string }> {
  const payload = JSON.stringify({ title, user_input: userInput, uploader }, null, 2);
  const parsed = await llmJson<{ song_name?: string; artist?: string }>(
    deps,
    INFER_SONG_INFO_PROMPT,
    payload,
    ctx,
  ).catch(() => null);
  return { song_name: str(parsed?.song_name), artist: str(parsed?.artist) };
}

// ─── Stored key → identity ─────────────────────────────

/**
 * Is a stored `bvid:cid` still downloadable?
 *
 * Checked against the page list rather than just the video page: a video can
 * exist while the specific part behind the cid has been removed or renumbered,
 * and downloading "the video" in that case is the wrong song.
 */
export async function probeSourceKey(
  deps: PipelineDeps,
  sourceKey: string,
  ctx: StepContext,
): Promise<NormalizedSource | null> {
  const [bvid, rawCid] = sourceKey.split(':');
  const cid = Number(rawCid);
  if (bvid === undefined || !Number.isInteger(cid)) return null;
  try {
    const pages = await deps.bilibili.pagelist(bvid, { signal: ctx.signal });
    const match = pages.find((p) => p.cid === cid);
    if (match === undefined) return null;
    return await normalizeSourceOnline(
      deps.bilibili,
      { bvid, page: match.page },
      { signal: ctx.signal },
    );
  } catch {
    // A dead key and an unreachable bilibili look the same from here; treat
    // both as "cannot use it", and let the caller decide what to do next.
    return null;
  }
}

/**
 * Find a song's source again after its key stopped resolving.
 *
 * Needs the LLM by definition — the only thing left to go on is the song's own
 * name and artist. Without one the honest answer is SOURCE_GONE with a message
 * saying what would fix it (fourth review ⑩).
 */
export async function reidentifySource(
  deps: PipelineDeps,
  song: SongData,
  ctx: StepContext,
): Promise<ResolvedTarget> {
  if (deps.llm === null) {
    throw new SourceGoneError(
      `「${song.name}」原来的来源已失效，且没有配置 LLM 无法自动找到新来源（配置 LLM 后可自动识别，或手动编辑链接）`,
    );
  }
  const query = song.artist === '' ? song.name : `${song.name} ${song.artist}`;
  return resolveKeyword(deps, query, ctx);
}

// ─── Bytes ─────────────────────────────────────────────

export interface StagedAudio {
  /** Finished mp3 at a task-scoped temp path, ready for `landSongFile`. */
  path: string;
  duration: number;
}

/**
 * Download and transcode into the song's own directory.
 *
 * Same-volume staging is deliberate: the Go version wrote to the system temp
 * directory and then renamed across devices, which fails on any setup where
 * the nest is not on the root filesystem.
 */
export async function fetchAudio(
  deps: PipelineDeps,
  input: { songId: string; taskId: string; bvid: string; cid: number },
  ctx: StepContext,
): Promise<StagedAudio> {
  const paths = stagePaths(input.songId, input.taskId);
  // Before any bytes move: the transfer exists only to be transcoded, so a
  // machine with no usable ffmpeg should fail here rather than after it has
  // pulled down the whole track (M7-18).
  await deps.mediaTools.acquire();
  // A brand-new song has no directory yet, and staging happens INSIDE it (the
  // whole point of same-volume staging), so it has to exist first.
  await mkdir(paths.dir, { recursive: true });
  const stream = await deps.bilibili.audioStream(input.bvid, input.cid, { signal: ctx.signal });

  ctx.reportStage('downloading');
  const response = await deps.bilibili.openAudio(stream.url, { signal: ctx.signal });
  if (response.body === null) {
    throw new BilibiliApiError(`audio stream for ${input.bvid}:${input.cid} had no body`);
  }
  await streamPipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(paths.download),
    { signal: ctx.signal },
  );

  ctx.reportStage('converting');
  const probe = await deps.mediaTools.use(async (tools) => {
    try {
      await ensureMp3(tools.ffmpeg.path, paths.download, paths.transcoded, {
        signal: ctx.signal,
        timeouts: deps.timeouts,
      });
    } finally {
      // The raw download is dead weight either way, and leaving it behind would
      // make the next startup recovery report residue that is not residue.
      await unlink(paths.download).catch(() => {});
    }
    return probeAudio(tools.ffprobe.path, paths.transcoded, {
      signal: ctx.signal,
      timeouts: deps.timeouts,
    });
  });
  return { path: paths.transcoded, duration: probe.duration };
}

// ─── Reuse ─────────────────────────────────────────────

/** The song already holding this source key, if any (M3-7 key pre-check). */
export function findSongByKey(
  db: LarkDatabase,
  provider: string,
  key: string,
): { id: string } | undefined {
  return db
    .select({ id: songs.id })
    .from(songs)
    .where(and(eq(songs.source_provider, provider), eq(songs.source_key, key)))
    .get();
}

// ─── Lyrics ────────────────────────────────────────────

export interface LyricsOutcome {
  written: boolean;
  platform: string | null;
  /** Why nothing was written, when nothing was. */
  reason: string | null;
}

/** Fetch and store lyrics for a song. Never throws for "nothing found". */
export async function runLyrics(
  deps: PipelineDeps,
  song: SongData,
  ctx: StepContext,
): Promise<LyricsOutcome> {
  ctx.reportStage('lyrics');
  const { best, result } = await fetchLyrics(
    { name: song.name, artist: song.artist, duration: song.duration },
    {
      fetchImpl: deps.fetchImpl,
      signal: ctx.signal,
      timeouts: deps.timeouts,
      origins: deps.lyricsOrigins,
      ...(deps.llm === null ? {} : { llmConfig: deps.llm }),
    },
  );

  if (best === null) {
    const failed = result.failures.map((f) => f.platform).join(', ');
    return {
      written: false,
      platform: null,
      reason:
        failed === ''
          ? '三个歌词源都没有找到匹配的 LRC'
          : `三个歌词源都没有可用结果（${failed} 请求失败）`,
    };
  }

  await writeLyrics(song.id, best.lrc);
  return { written: true, platform: best.platform, reason: null };
}

// ─── LLM helpers ───────────────────────────────────────

async function llm(
  deps: PipelineDeps,
  system: string,
  user: string,
  ctx: StepContext,
): Promise<string> {
  if (deps.llm === null) throw new LlmNotConfiguredError();
  return chatCompletion(deps.llm, system, user, {
    signal: ctx.signal,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeouts.llm,
  });
}

async function llmJson<T>(
  deps: PipelineDeps,
  system: string,
  user: string,
  ctx: StepContext,
): Promise<T | null> {
  const answer = await llm(deps, system, user, ctx);
  try {
    return JSON.parse(cleanLlmJson(answer)) as T;
  } catch {
    // Unparseable output is a degraded answer, not a failed task: every caller
    // has a deterministic fallback for `null`.
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
