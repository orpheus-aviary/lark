// Which of a list's videos are going to be downloaded (N4f-1, §2.1).
//
// Pure functions over a `Set<string>` of bvids, and that is the whole design:
// §1.5 needs a 5000-row list to stay on the frame budget, and the way it does
// is by NOT putting a checkbox's state in the row. A `FlatList` recycles rows;
// a `useState` per row would be five thousand of them, re-created as the list
// scrolls, and "全选" would have to reach into components that are not
// mounted. One set at the top of the page answers every question here in O(1).
//
// KEYED BY BVID, like the desktop's modal (`BatchSelectModal.tsx`). A list that
// contains the same video twice — the same bvid in two pages of a favourites
// folder — therefore has ONE row and counts once, which is also what the engine
// would do with it: two identical items merge onto one task (`#mergeInto`), so
// a picker that showed two rows would promise a download it cannot deliver.
// `pickable` is where that collapse happens, once, before anything is rendered.

import { DOWNLOAD_BATCH_ITEMS_MAX, type FetchListData } from '@lark/shared';

/** One row of an expanded list. */
export type ListVideo = FetchListData['videos'][number];

/**
 * The rows a picker shows: list order, one per bvid.
 *
 * Everything below assumes its input came through here — `chosen.size` is the
 * count on the button precisely because the set and the rows agree on what
 * "one video" is.
 */
export function pickable(videos: readonly ListVideo[]): readonly ListVideo[] {
  const seen = new Set<string>();
  return videos.filter((video) => {
    if (seen.has(video.bvid)) return false;
    seen.add(video.bvid);
    return true;
  });
}

/** Everything ticked — how a freshly expanded list arrives (decision e). */
export function chooseAll(videos: readonly ListVideo[]): ReadonlySet<string> {
  return new Set(videos.map((video) => video.bvid));
}

/** One row's checkbox. A new set every time: React compares by identity. */
export function toggleOne(chosen: ReadonlySet<string>, bvid: string): ReadonlySet<string> {
  const next = new Set(chosen);
  if (!next.delete(bvid)) next.add(bvid);
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
  videos: readonly ListVideo[],
): ReadonlySet<string> {
  return allChosen(chosen, videos) ? new Set() : chooseAll(videos);
}

/** Whether every row is ticked — the label on that button. */
export function allChosen(chosen: ReadonlySet<string>, videos: readonly ListVideo[]): boolean {
  return videos.length > 0 && videos.every((video) => chosen.has(video.bvid));
}

/** What a submission would carry: the ticked rows, in the list's own order. */
export function chosenVideos(
  videos: readonly ListVideo[],
  chosen: ReadonlySet<string>,
): readonly ListVideo[] {
  return videos.filter((video) => chosen.has(video.bvid));
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
