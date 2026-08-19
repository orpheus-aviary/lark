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

import type { DownloadStage, LlmConfig, SongData } from '@lark/shared';
import type { PortableDb } from '../db.js';
import { BilibiliApiError, LlmNotConfiguredError, SourceGoneError } from '../errors.js';
import { writeLyrics } from '../library/lyrics.js';
import type { FileContext } from '../ports/fs.js';
import type { BiliPage, BilibiliClient } from './bilibili.js';
import { type NormalizedSource, normalizeSourceOnline } from './link.js';
import { chatCompletion, cleanLlmJson } from './llm.js';
import { fetchLyrics } from './lyrics/select.js';
import type { LyricsOrigins } from './lyrics/shared.js';
import { ANALYZE_PROMPT, INFER_SONG_INFO_PROMPT, multiPPrompt, selectPrompt } from './prompts.js';
import type { DownloadTarget } from './target.js';
import type { DownloadTimeouts } from './timeouts.js';

export interface PipelineDeps {
  /** The library, as one connection (N1c) — drizzle and the raw handle together. */
  store: PortableDb;
  /** Where song files live, and how to touch them (N1c). */
  files: FileContext;
  bilibili: BilibiliClient;
  /** The task's config snapshot: `null` means no LLM for this whole task. */
  llm: LlmConfig | null;
  timeouts: DownloadTimeouts;
  fetchImpl?: typeof fetch;
  lyricsOrigins?: Partial<LyricsOrigins>;
}

export interface StepContext {
  signal: AbortSignal;
  reportStage: (stage: DownloadStage) => void;
  /**
   * How much of the transfer has arrived (§3.5). Called per chunk — the
   * throttling that decides which of those become events is the engine's, not
   * the transfer's: only the engine knows what it last told anyone.
   */
  reportProgress?: (receivedBytes: number, totalBytes: number | null) => void;
}

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
 * Naming is the submitter's choice, taken once and carried on the target
 * (0.3.0 §3.6-1). `original` is the M3-7 rule unchanged: the title as it
 * stands, the uploader as the artist, so the same URL always produces the same
 * song — which is what the Go version lost by running everything through the
 * model. `clean` asks for that model pass explicitly, and falls back to the
 * same two values when it cannot answer.
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
  // The list's title when a list gave one, the video's own otherwise — and
  // whichever it is, it is also what `clean` falls back to.
  const title = target.title ?? view.title;
  if (target.naming === 'original') return { source, name: title, artist: view.ownerName };

  ctx.reportStage('naming');
  const inferred = await inferSongInfo(deps, title, '', view.ownerName, ctx);
  return {
    source,
    name: inferred.song_name !== '' ? inferred.song_name : title,
    artist: inferred.artist !== '' ? inferred.artist : view.ownerName,
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

/**
 * Ask the model for the song and the artist inside a title. Degrades to empty
 * strings, which every caller has a deterministic fallback for.
 *
 * Everything except a cancellation, that is. An aborted fetch and a provider
 * 500 both arrive here as `LlmRequestError` — only the caller's OWN signal can
 * tell them apart, and swallowing the first would let a cancelled task carry
 * on downloading the audio it was told to stop fetching (§3.6-1).
 */
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
  ).catch(() => {
    ctx.signal.throwIfAborted();
    return null;
  });
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

  await writeLyrics(deps.store, deps.files, song.id, best.lrc);
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
