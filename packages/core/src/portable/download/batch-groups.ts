// What a batch GROUP becomes on the wire, for the ends that build one.
//
// 🔴 WHY THIS IS IN PORTABLE AND NOT IN A FRONT END. 0.5.1 decided that a
// multi-part video IS a group — the same shape a favourites folder and a
// collection already had: a name you can edit, a tick per row, one naming
// answer, and a playlist of its own when it is submitted (`INVARIANTS.md` §3).
// It was then written twice, once per end, and the two disagreed within three
// days: the desktop submitted `{kind:'new'}` and the phone submitted whatever
// the 「存到」 picker was showing, so the same link produced a new playlist on
// one end and loose songs on the other. The invariant said they matched.
//
// A sentence in a document cannot fail. A function two callers share can, so
// this is that function.
//
// WHAT A PART ROW SAYS ON THE WIRE, and why it says so little:
//
//   `bvid` is the VIDEO's, repeated on every row — a part is a page of one
//   video, not a video of its own (that is what separates this from a list
//   group, where each row carries its own bvid).
//
//   `title` is `null` on every row, ALWAYS. The pipeline fetches the page list
//   anyway and reads the part's own title out of it (§7.4); a title sent from
//   here would be a second source for one string, and two sources for one
//   string drift. This is the same rule the list group breaks on purpose — a
//   list's title is BETTER than the video's, so it rides along.
//
//   No `source`. A video is not a list, and inventing a list identity is a lie
//   the download record then repeats forever (0.5.0 ④).

import type {
  DownloadBatchGroupInput,
  DownloadBatchItemInput,
  DownloadNamingMode,
} from '@lark/shared';

/**
 * One multi-part video's picked pages, as a group.
 *
 * `name` is the playlist this group creates — the video's title unless
 * somebody edited it. Blank is not refused here: the engine already refuses an
 * empty playlist name, and a second copy of that rule is a second place for it
 * to drift.
 */
export function partsGroupPayload(
  bvid: string,
  name: string,
  pages: readonly number[],
  naming: DownloadNamingMode,
): DownloadBatchGroupInput {
  const items: DownloadBatchItemInput[] = pages.map((page) => ({
    kind: 'video',
    bvid,
    page,
    title: null,
    naming,
  }));
  return { target: { kind: 'new', name }, items };
}
