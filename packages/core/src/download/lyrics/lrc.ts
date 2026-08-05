// LRC parsing shared by all three platforms (M3-9).
//
// One implementation of `normalizeLrc`, deliberately: the Go version had the
// netease path inline its own copy, which is how netease ended up with a
// different validity rule than QQ and Kugou.
//
// Validity is a timestamp REGEX, not the Go version's `contains("[0")`. That
// test rejected any song whose lyrics start after the ten-minute mark and
// accepted a plain-text file containing the literal characters `[0`.
//
// Time-axis parsing itself lives in @lark/shared (M4-13④ single source);
// this module keeps only the candidate-selection concerns.

import { hasLrcTimestamps, parseLrc } from '@lark/shared';

/** One platform's answer, before selection. */
export interface LyricsCandidate {
  platform: LyricsPlatform;
  songName: string;
  artist: string;
  /** Full normalised LRC. */
  lrc: string;
  /** First lyric lines, for the LLM prompt. */
  preview: string;
  /** Last lyric lines — catches truncated lyrics the head cannot show. */
  tailPreview: string;
  /** Last timestamp as `M:SS`, or `''`. */
  endTime: string;
  /** The same, in seconds; `null` when there is no timestamp. */
  endSeconds: number | null;
}

export const LYRICS_PLATFORMS = ['netease', 'qq', 'kugou'] as const;
export type LyricsPlatform = (typeof LYRICS_PLATFORMS)[number];

/** Metadata tags carry no lyrics and must not enter a preview. */
const META_PREFIXES = ['[ti:', '[ar:', '[al:', '[by:', '[offset:', '[kana:', '[length:'];

/**
 * Strip BOM, unify line endings, and verify this is really timed LRC.
 * Returns `null` for anything unusable — a per-candidate filter, not an
 * exception, because "this platform's third hit has no lyrics" is normal.
 */
export function normalizeLrc(raw: string): string | null {
  let lrc = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (lrc === '') return null;
  if (!hasLrcTimestamps(lrc)) return null;
  // Collapse the runs of blank lines some platforms pad with.
  lrc = lrc.replace(/\n{3,}/g, '\n\n');
  return lrc;
}

/** The last timestamp in the file — the cross-check against audio duration. */
export function lrcEndTime(lrc: string): { text: string; seconds: number } | null {
  const last = parseLrc(lrc).at(-1);
  if (last === undefined) return null;
  const minutes = Math.floor(last.time / 60);
  const seconds = Math.floor(last.time % 60);
  return {
    text: `${minutes}:${String(seconds).padStart(2, '0')}`,
    seconds: minutes * 60 + seconds,
  };
}

/** First `n` lyric lines, joined — what the LLM sees of the content. */
export function lrcPreview(lrc: string, n: number): string {
  return lyricLines(lrc).slice(0, n).join(' / ');
}

/** Last `n` lyric lines. A truncated file looks fine from the head. */
export function lrcTailPreview(lrc: string, n: number): string {
  const lines = lyricLines(lrc);
  return lines.slice(Math.max(0, lines.length - n)).join(' / ');
}

/** Text after the timestamp, for every line that has any. */
function lyricLines(lrc: string): string[] {
  const out: string[] = [];
  for (const raw of lrc.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (META_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
    const close = line.lastIndexOf(']');
    if (close === -1) continue;
    const text = line.slice(close + 1).trim();
    if (text !== '') out.push(text);
  }
  return out;
}

/** Build a candidate from raw LRC, or `null` when the LRC is unusable. */
export function toCandidate(
  platform: LyricsPlatform,
  songName: string,
  artist: string,
  rawLrc: string,
): LyricsCandidate | null {
  const lrc = normalizeLrc(rawLrc);
  if (lrc === null) return null;
  const end = lrcEndTime(lrc);
  return {
    platform,
    songName,
    artist,
    lrc,
    preview: lrcPreview(lrc, 4),
    tailPreview: lrcTailPreview(lrc, 3),
    endTime: end?.text ?? '',
    endSeconds: end?.seconds ?? null,
  };
}
