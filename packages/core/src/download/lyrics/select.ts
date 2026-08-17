// Collecting candidates from all three platforms, and choosing one (M3-9).
//
// The choice has two implementations and the deterministic one is the floor,
// not the fallback-of-last-resort: with no LLM configured — the whole point of
// R16 — lyrics still work, they just pick by similarity instead of by
// judgement. The Go version's degraded path was "take candidate zero", which
// is whichever platform happened to answer first.
//
// The scoring rule is FROZEN (a tweak changes which lyrics land on disk):
//
//   normalize = NFKC → lowercase → strip whitespace and punctuation
//   sim       = Dice coefficient over character bigrams of
//               "<name> <artist>" vs "<title> <singer>"
//   penalty   = duration and end_time both known
//                 ? min(|end − duration|, 60s) / 60s × 0.5
//                 : 0
//   score     = sim − penalty
//   tie-break = platform order (netease → qq → kugou), then arrival order
//
// The penalty is what catches a title-perfect match that is actually a
// different cut — a 30s TV edit of a 4-minute song scores 1.0 on similarity.

import type { LlmConfig } from '@lark/shared';
import { chatCompletion } from '../llm.js';
import { lyricsSelectPrompt } from '../prompts.js';
import { DEFAULT_TIMEOUTS, type DownloadTimeouts } from '../timeouts.js';
import { searchKugou } from './kugou.js';
import { LYRICS_PLATFORMS, type LyricsCandidate, type LyricsPlatform } from './lrc.js';
import { searchNetease } from './netease.js';
import { searchQq } from './qq.js';
import type { LyricsQuery, LyricsSourceOptions } from './shared.js';

const SOURCES: Record<
  LyricsPlatform,
  (query: LyricsQuery, options?: LyricsSourceOptions) => Promise<LyricsCandidate[]>
> = {
  netease: searchNetease,
  qq: searchQq,
  kugou: searchKugou,
};

/** How far off the audio length a candidate can be before the penalty caps. */
const PENALTY_WINDOW_SECONDS = 60;
const PENALTY_WEIGHT = 0.5;

export interface LyricsCollectResult {
  candidates: LyricsCandidate[];
  /** Per-platform failures, for a debug log line. Never fatal. */
  failures: { platform: LyricsPlatform; message: string }[];
}

/**
 * Query all three platforms concurrently. `allSettled`, not `all`: one
 * platform's outage must not cost the other two.
 */
export async function collectLyricsCandidates(
  query: LyricsQuery,
  options: LyricsSourceOptions = {},
): Promise<LyricsCollectResult> {
  const settled = await Promise.allSettled(
    LYRICS_PLATFORMS.map((platform) => SOURCES[platform](query, options)),
  );

  const candidates: LyricsCandidate[] = [];
  const failures: LyricsCollectResult['failures'] = [];
  settled.forEach((result, index) => {
    // Platform order here is also the tie-break order below.
    const platform = LYRICS_PLATFORMS[index] as LyricsPlatform;
    if (result.status === 'fulfilled') {
      candidates.push(...result.value);
    } else {
      const reason = result.reason;
      failures.push({
        platform,
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  });
  return { candidates, failures };
}

export interface LyricsSelectOptions {
  /** Absent / unconfigured → the heuristic decides. */
  llmConfig?: LlmConfig;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeouts?: DownloadTimeouts;
}

/**
 * Pick one candidate. Never throws: an LLM that errors, times out, or answers
 * something that is not a valid index falls through to the heuristic, because
 * the alternative is failing a download over its lyrics.
 */
export async function selectLyricsCandidate(
  candidates: readonly LyricsCandidate[],
  query: LyricsQuery,
  options: LyricsSelectOptions = {},
): Promise<LyricsCandidate | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;

  const config = options.llmConfig;
  if (config !== undefined) {
    const picked = await pickWithLlm(candidates, query, config, options).catch(() => null);
    if (picked !== null) return picked;
  }
  return pickByHeuristic(candidates, query);
}

/** Collect + select in one call — what the lyrics task runs. */
export async function fetchLyrics(
  query: LyricsQuery,
  options: LyricsSourceOptions & LyricsSelectOptions = {},
): Promise<{ best: LyricsCandidate | null; result: LyricsCollectResult }> {
  const result = await collectLyricsCandidates(query, options);
  return { best: await selectLyricsCandidate(result.candidates, query, options), result };
}

// ─── LLM selection ─────────────────────────────────────

async function pickWithLlm(
  candidates: readonly LyricsCandidate[],
  query: LyricsQuery,
  config: LlmConfig,
  options: LyricsSelectOptions,
): Promise<LyricsCandidate | null> {
  // The summary deliberately excludes the full LRC: previews plus end_time are
  // what the prompt reasons over, and three full lyric files would dominate
  // the context for no gain.
  const summary = candidates.map((c, index) => ({
    index: index + 1,
    platform: c.platform,
    song_name: c.songName,
    artist: c.artist,
    preview: c.preview,
    tail_preview: c.tailPreview,
    end_time: c.endTime,
  }));

  const answer = await chatCompletion(
    config,
    lyricsSelectPrompt(query.name, query.artist, query.duration),
    JSON.stringify(summary, null, 2),
    {
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      timeoutMs: (options.timeouts ?? DEFAULT_TIMEOUTS).lyricsSelect,
    },
  );

  const index = Number(answer.trim());
  if (!Number.isInteger(index) || index < 1 || index > candidates.length) return null;
  return candidates[index - 1] ?? null;
}

// ─── Deterministic selection ───────────────────────────

/** The frozen rule. Exported for the tests that pin it. */
export function scoreCandidate(candidate: LyricsCandidate, query: LyricsQuery): number {
  const sim = diceSimilarity(
    `${query.name} ${query.artist}`,
    `${candidate.songName} ${candidate.artist}`,
  );
  return sim - durationPenalty(candidate, query.duration);
}

function durationPenalty(candidate: LyricsCandidate, duration: number): number {
  // No audio duration or no timestamps → no evidence, so no penalty. Guessing
  // one would push every candidate down by the same amount anyway.
  if (duration <= 0 || candidate.endSeconds === null) return 0;
  const drift = Math.min(Math.abs(candidate.endSeconds - duration), PENALTY_WINDOW_SECONDS);
  return (drift / PENALTY_WINDOW_SECONDS) * PENALTY_WEIGHT;
}

export function pickByHeuristic(
  candidates: readonly LyricsCandidate[],
  query: LyricsQuery,
): LyricsCandidate | null {
  let best: LyricsCandidate | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  // Iterating in arrival order — which is platform order, then per-platform
  // rank — makes `>` alone implement the whole tie-break rule.
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, query);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** NFKC + case fold + drop whitespace and punctuation. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Dice coefficient over character bigrams, multiset-aware. */
export function diceSimilarity(a: string, b: string): number {
  const left = bigrams(normalizeForMatch(a));
  const right = bigrams(normalizeForMatch(b));
  const leftTotal = count(left);
  const rightTotal = count(right);
  if (leftTotal === 0 || rightTotal === 0) {
    return normalizeForMatch(a) === normalizeForMatch(b) ? 1 : 0;
  }
  let shared = 0;
  for (const [gram, n] of left) {
    shared += Math.min(n, right.get(gram) ?? 0);
  }
  return (2 * shared) / (leftTotal + rightTotal);
}

function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i + 1 < text.length; i++) {
    const gram = text.slice(i, i + 2);
    out.set(gram, (out.get(gram) ?? 0) + 1);
  }
  return out;
}

function count(grams: Map<string, number>): number {
  let total = 0;
  for (const n of grams.values()) total += n;
  return total;
}
