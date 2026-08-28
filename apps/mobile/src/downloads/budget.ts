// How much of a playlist fits before lark runs out of room (0.1.1 ⑤).
//
// THE RULE (user, 2026-08-27): an automatic download stops at the cache limit
// and says so — it does not make room by deleting other songs. Somebody who
// wants that says so by tapping 重下 on the refused row, which goes straight
// to the engine and lets the ordinary eviction do its work. So "下新删旧" is a
// deliberate act rather than something a batch does behind your back.
//
// WHY THERE IS AN ESTIMATE AT ALL. Nothing knows what a song weighs before it
// is fetched, and the decision has to be made at the moment of the tap. The
// alternative — enqueue everything and stop when the disk says so — overshoots
// by at least one song and turns the rest into cancellations rather than an
// answer. So: seconds × bytes-per-second, CALIBRATED off this device rather
// than guessed, because every library here came from the same source at the
// same quality (`file_size` rides along with `has_file` on every row).
//
// IT STOPS, IT DOES NOT CHERRY-PICK. The first song that will not fit ends the
// batch, and everything after it is refused too. Skipping it to squeeze in
// smaller ones later in the list would make 「下了 7 首」 mean an arbitrary
// seven, and nobody could tell which.

import type { DownloadRecord } from '@lark/core/portable';
import type { SongData } from '@lark/shared';

/**
 * What a second of audio weighs when this device has nothing to go on: 128
 * kbps, which is bilibili's usual AAC and therefore what the first download
 * into an empty library is most likely to be.
 */
export const FALLBACK_BYTES_PER_SECOND = 16 * 1024;

/** The code a refusal carries. Deliberately NOT in `RETRYABLE_CODES` (⑧). */
export const CACHE_LIMIT_CODE = 'CACHE_LIMIT';

export interface BudgetInput {
  /** Every byte of lark audio on this DEVICE — the limit is device-wide. */
  usedBytes: number;
  /** `0` means unlimited, the same way the setting does. */
  limitBytes: number;
  bytesPerSecond: number;
}

export interface BudgetPlan {
  /** In list order, up to the first one that will not fit. */
  queue: readonly SongData[];
  /** That one and everything after it. */
  refused: readonly SongData[];
  /** Nothing to fetch them from — imported, or a source that was never known. */
  unavailable: readonly SongData[];
}

/** A song this device could fetch: no file yet, and somewhere to get it from. */
export function isFetchable(song: SongData): boolean {
  return song.has_file === false && song.source_key !== null;
}

/**
 * What a second of audio has actually weighed here.
 *
 * Over the songs that HAVE files, which is the only sample there is. A library
 * with none falls back to the constant; so does one whose rows somehow carry
 * no duration, because dividing by zero would make every song free.
 */
export function bytesPerSecondOf(songs: readonly SongData[]): number {
  let bytes = 0;
  let seconds = 0;
  for (const song of songs) {
    if (song.has_file !== true || song.file_size === undefined) continue;
    if (song.duration <= 0) continue;
    bytes += song.file_size;
    seconds += song.duration;
  }
  if (seconds <= 0 || bytes <= 0) return FALLBACK_BYTES_PER_SECOND;
  return bytes / seconds;
}

/** What one song is expected to cost. A song with no duration costs a minute. */
export function estimateBytes(song: SongData, bytesPerSecond: number): number {
  const seconds = song.duration > 0 ? song.duration : 60;
  return Math.round(seconds * bytesPerSecond);
}

export function planWithinBudget(songs: readonly SongData[], input: BudgetInput): BudgetPlan {
  const queue: SongData[] = [];
  const refused: SongData[] = [];
  const unavailable: SongData[] = [];
  let projected = input.usedBytes;
  let full = false;

  for (const song of songs) {
    if (song.has_file === true) continue; // already here; not this batch's business
    if (!isFetchable(song)) {
      unavailable.push(song);
      continue;
    }
    if (full) {
      refused.push(song);
      continue;
    }
    const cost = estimateBytes(song, input.bytesPerSecond);
    if (input.limitBytes > 0 && projected + cost > input.limitBytes) {
      full = true;
      refused.push(song);
      continue;
    }
    projected += cost;
    queue.push(song);
  }
  return { queue, refused, unavailable };
}

/**
 * The row a refused song leaves behind.
 *
 * A record with no task behind it, which is the point: without one, hitting
 * the limit would be a toast that scrolls away, and the songs that did not
 * come down would be indistinguishable from songs nobody asked for.
 *
 * The id carries no timestamp on purpose — tapping 全部下载 twice replaces the
 * row rather than stacking a second identical one.
 */
export function refusedRecord(song: SongData, limitMb: number, at: number): DownloadRecord {
  return {
    id: `cache-limit:${song.id}`,
    kind: 'ensure-file',
    state: 'failed',
    title: song.name,
    artist: song.artist,
    input: { type: 'song', song_id: song.id },
    origin: { kind: 'song', song_id: song.id },
    playlist_ids: [],
    song_id: song.id,
    error_code: CACHE_LIMIT_CODE,
    error_message: `自动下载到了缓存上限（${limitMb}MB）。调高上限，或者点「重下」手动下——那会按最近最少使用清理旧文件。`,
    finished_at: at,
  };
}

/** One line for what a 全部下载 came to. */
export function describeBudgetPlan(plan: BudgetPlan): string {
  if (plan.queue.length === 0 && plan.refused.length === 0) {
    return plan.unavailable.length === 0
      ? '这个歌单里的歌都已经在本机了'
      : `没有可以下载的：${plan.unavailable.length} 首没有来源`;
  }
  const notes = [
    ...(plan.refused.length === 0 ? [] : [`${plan.refused.length} 首到了缓存上限`]),
    ...(plan.unavailable.length === 0 ? [] : [`${plan.unavailable.length} 首没有来源`]),
  ];
  const queued = `已排 ${plan.queue.length} 首`;
  return notes.length === 0 ? queued : `${queued}；${notes.join('，')}`;
}
