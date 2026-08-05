// LRC time-axis parsing — THE one implementation core and the renderer share
// (M4-13④ froze the semantics; neither side may grow a local parser):
//
// - `{time, text}[]` in STABLE ascending time order (duplicates keep their
//   file order);
// - a line with several time tags expands to one entry per tag;
// - 2 fractional digits are centiseconds, 3 are milliseconds;
// - `[ti:]` / `[ar:]` … metadata is ignored, and so is `[offset:]` — the song
//   offset's single source of truth is the DB `lyrics_offset`, never a second
//   in-file offset stacked on top;
// - EMPTY text lines are kept: a timed blank is the interlude marker;
// - BOM and CRLF are stripped;
// - current-line lookup: no current line before the first entry; otherwise the
//   LAST entry with `time <= currentTime + offset` (binary search).
//
// M3's lastIndex lesson travels with the code: a /g regex must never serve
// both `.test()` and `matchAll` — `.test()` advances `lastIndex`, so the next
// match starts mid-string. Hence one source pattern, two instances.

const TIMESTAMP_PATTERN = String.raw`\[(\d{1,2}):(\d{2})[.:](\d{2,3})\]`;
const HAS_TIMESTAMP = new RegExp(TIMESTAMP_PATTERN);
const LEADING_TIMESTAMPS = new RegExp(`^(?:${TIMESTAMP_PATTERN})+`);
const ALL_TIMESTAMPS = new RegExp(TIMESTAMP_PATTERN, 'g');

/** One timed lyric line. `time` is in seconds (fractional). */
export interface LrcLine {
  time: number;
  text: string;
}

/** True when the text contains at least one `[mm:ss.xx]` tag — "is this LRC?". */
export function hasLrcTimestamps(text: string): boolean {
  return HAS_TIMESTAMP.test(text);
}

function tagSeconds(minutes: string, seconds: string, fraction: string): number {
  const fractionSeconds = fraction.length === 3 ? Number(fraction) / 1000 : Number(fraction) / 100;
  return Number(minutes) * 60 + Number(seconds) + fractionSeconds;
}

/**
 * Parse raw LRC text into the timed line list. Lines without a leading time
 * tag (metadata, offset, stray prose) contribute nothing; everything else —
 * including timed EMPTY lines — is kept.
 */
export function parseLrc(raw: string): LrcLine[] {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const entries: LrcLine[] = [];
  for (const line of text.split('\n')) {
    const lead = LEADING_TIMESTAMPS.exec(line);
    if (lead === null) continue;
    const lyricText = line.slice(lead[0].length).trim();
    for (const tag of lead[0].matchAll(ALL_TIMESTAMPS)) {
      entries.push({
        time: tagSeconds(tag[1] as string, tag[2] as string, tag[3] as string),
        text: lyricText,
      });
    }
  }
  // Array.prototype.sort is stable — duplicate timestamps keep file order.
  return entries.sort((a, b) => a.time - b.time);
}

/**
 * Index of the current line: the LAST entry with `time <= currentTime +
 * offsetSeconds`, or `-1` before the first entry. Binary search — the lookup
 * runs on every timeupdate tick.
 */
export function currentLrcIndex(
  lines: readonly LrcLine[],
  currentTime: number,
  offsetSeconds: number,
): number {
  const target = currentTime + offsetSeconds;
  let low = 0;
  let high = lines.length - 1;
  let hit = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((lines[mid] as LrcLine).time <= target) {
      hit = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return hit;
}
