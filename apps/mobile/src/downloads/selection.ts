// Which of a list's videos are going to be downloaded (N4f-1, §2.1).
//
// Pure functions over a `Set<string>` of bvids, and that is the whole design:
// §1.5 needs a 5000-row list to stay on the frame budget, and the way it does
// is by NOT putting a checkbox's state in the row. A `FlatList` recycles rows;
// a `useState` per row would be five thousand of them, re-created as the list
// scrolls, and "全选" would have to reach into components that are not
// mounted. One set at the top of the page answers every question here in O(1).
//
// KEYED BY A STRING THE SOURCE CHOOSES. For an expanded list that is the bvid,
// like the desktop's modal (`BatchSelectModal.tsx`): a folder holding the same
// video twice therefore has ONE row and counts once, which is also what the
// engine does with it (two identical items merge onto one task, `#mergeInto`),
// so a picker showing two rows would promise a download it cannot deliver.
// `pickable` is where that collapse happens, once, before anything is rendered.
//
// GENERIC SINCE N4h, because the picker grew a second source: a pasted block of
// lines, where the row is a line rather than a video and two of them can be the
// same link written differently. What every source owes this file is a stable
// key; what it means is the source's business.

import { DOWNLOAD_BATCH_ITEMS_MAX, type FetchListData } from '@lark/shared';

/** Anything this file can tick: it needs an identity and nothing else. */
export interface Pickable {
  key: string;
}

/**
 * What the picker screen draws, whatever produced it (N4h).
 *
 * Two sources fill this in: an expanded favourites folder, where every row is
 * a video and none of them can be refused, and a pasted block of lines, where
 * a row may be a link nobody can follow. One contract rather than two renderers
 * — the screen should not have to know which door it came through.
 */
export interface PickRow extends Pickable {
  /** The row's own line: a song title, a bvid, a query, a URL. */
  label: string;
  /** What was pasted, when the label is something else. */
  note: string | null;
  /** Why it cannot be ticked. `null` means it can. */
  reason: string | null;
}

/** One row of an expanded list (N4f). */
export interface ListVideo extends PickRow {
  bvid: string;
  title: string;
  duration: number | null;
}

/** `fetchList` rows, keyed for the picker. The key IS the bvid (§1.5). */
export function listRows(videos: FetchListData['videos']): readonly ListVideo[] {
  // A list row is never refused: everything in a favourites folder is a video
  // with a bvid, and the walk already dropped what it could not read.
  return videos.map((video) => ({
    ...video,
    key: video.bvid,
    label: video.title,
    note: null,
    reason: null,
  }));
}

/**
 * The rows a picker shows: list order, one per bvid.
 *
 * Everything below assumes its input came through here — `chosen.size` is the
 * count on the button precisely because the set and the rows agree on what
 * "one video" is.
 */
export function pickable<T extends Pickable>(rows: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.key)) return false;
    seen.add(row.key);
    return true;
  });
}

/** Everything ticked — how a freshly expanded list arrives (decision e). */
export function chooseAll(rows: readonly Pickable[]): ReadonlySet<string> {
  return new Set(rows.map((row) => row.key));
}

/** One row's checkbox. A new set every time: React compares by identity. */
export function toggleOne(chosen: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(chosen);
  if (!next.delete(key)) next.add(key);
  return next;
}

/**
 * The header's single button, which is 全不选 when everything is ticked and
 * 全选 otherwise (the desktop's `toggleAll`, same rule).
 *
 * "Everything" is counted against the rows, not against the set: a set holding
 * a bvid that is not in this list would otherwise make a full selection look
 * partial forever.
 */
export function toggleEvery(
  chosen: ReadonlySet<string>,
  rows: readonly Pickable[],
): ReadonlySet<string> {
  return allChosen(chosen, rows) ? new Set() : chooseAll(rows);
}

/** Whether every row is ticked — the label on that button. */
export function allChosen(chosen: ReadonlySet<string>, rows: readonly Pickable[]): boolean {
  return rows.length > 0 && rows.every((row) => chosen.has(row.key));
}

/** What a submission would carry: the ticked rows, in the source's own order. */
export function chosenRows<T extends Pickable>(
  rows: readonly T[],
  chosen: ReadonlySet<string>,
): readonly T[] {
  return rows.filter((row) => chosen.has(row.key));
}

/**
 * Why this many videos cannot be submitted at once, or `null` (decision d).
 *
 * The desktop's sentence, verbatim, because it is the same ceiling and a phone
 * that phrased it differently would be a second wording of one rule
 * (`BatchSelectModal.tsx:210-217`).
 *
 * TWO NUMBERS, NOT ONE: a single expansion may return up to
 * `FETCH_LIST_ITEMS_MAX` (5000) rows while a batch may submit at most 1000, so
 * a full folder can be picked and still be refused. Said BEFORE the submission
 * — the button carries this and is disabled — rather than after it, which is
 * the difference between a rule and a rejection.
 */
export function overItemLimit(count: number): string | null {
  if (count <= DOWNLOAD_BATCH_ITEMS_MAX) return null;
  return `一次最多 ${DOWNLOAD_BATCH_ITEMS_MAX} 个视频（当前 ${count}），请分批提交`;
}
