// What a group in the batch dialog IS, and what it becomes on the wire
// (0.5.1，用户 2026-08-31：「格式也和合集完全统一」).
//
// 🔴 TWO SOURCES, ONE GROUP. A favourites folder, a collection, and a
// multi-part video are the same thing to a person: a name, a list of songs
// under it, a tick each, and one answer for how they are named. 0.5.1 first
// gave the parts a dialog of their own and the difference was visible — so
// they are one shape now, and this module is the half of it that can be
// decided without a screen.
//
// WHAT DIFFERS IS ONLY WHAT AN ITEM SAYS ON THE WIRE. A list row is a video of
// its own (`bvid`, no page) and carries the list's title, because that title
// is better than the video's and is what `clean` reads a song name out of. A
// part row is a page of ONE video and carries no title at all: the pipeline
// reads the part's own title out of the page list it fetches anyway (§7.4),
// and two sources for one string drift.

import { partsGroupPayload } from '@lark/core/portable';
import type {
  DownloadBatchGroupInput,
  DownloadBatchItemInput,
  DownloadNamingMode,
  FetchListRequest,
  ParsedItem,
} from '@lark/shared';
import { listSource } from '@lark/shared';

/** One tickable line. `key` is the row's identity within its group. */
export interface GroupRow {
  key: string;
  label: string;
  checked: boolean;
}

interface CommonGroup {
  id: string;
  /** The playlist this group will create. Editable, and it is the name. */
  title: string;
  /**
   * Checked = keep the titles this group carries; unchecked = let the model
   * read a song name out of them (§3.6-1).
   */
  useOriginalTitle: boolean;
  rows: readonly GroupRow[];
  loading: boolean;
  /** Partial-success warning, or the reason nothing could be fetched. */
  error: string | null;
}

export interface ListGroup extends CommonGroup {
  kind: 'list';
  query: FetchListRequest;
  /** What it was picked out of, for the download record (0.5.0 ④). */
  source: Extract<ParsedItem, { kind: 'favorites' | 'collection' }>;
}

export interface PartsGroup extends CommonGroup {
  kind: 'parts';
  bvid: string;
}

export type BatchGroup = ListGroup | PartsGroup;

export function listGroupId(
  item: Extract<ParsedItem, { kind: 'favorites' | 'collection' }>,
): string {
  return item.kind === 'favorites'
    ? `favorites:${item.media_id}`
    : `collection:${item.mid}:${item.season_id}`;
}

export function partsGroupId(bvid: string): string {
  return `parts:${bvid}`;
}

export function listQuery(
  item: Extract<ParsedItem, { kind: 'favorites' | 'collection' }>,
): FetchListRequest {
  return item.kind === 'favorites'
    ? { type: 'favorites', media_id: item.media_id }
    : { type: 'collection', mid: item.mid, season_id: item.season_id };
}

export function checkedRows(group: BatchGroup): readonly GroupRow[] {
  return group.rows.filter((row) => row.checked);
}

/**
 * One group, in wire shape.
 *
 * Every group creates its own playlist — that is what makes a group a group,
 * and 0.5.1 extended it to the parts of a video on purpose: a 「歌曲合集」
 * uploaded as forty parts is a playlist by any other name.
 *
 * 🔴 THE PARTS BRANCH IS NOT WRITTEN HERE (2026-08-31). It is
 * `partsGroupPayload` in `@lark/core/portable`, and the phone's picker calls
 * the same function. The two ends each had their own copy for three days and
 * the copies disagreed — the desktop created a playlist, the phone submitted
 * into whatever 「存到」 was showing — while `INVARIANTS.md` §3 said they
 * matched. The list branch stays here because only this end has list groups.
 */
export function groupPayload(group: BatchGroup): DownloadBatchGroupInput {
  const naming: DownloadNamingMode = group.useOriginalTitle ? 'original' : 'clean';
  const rows = checkedRows(group);
  if (group.kind === 'parts') {
    return partsGroupPayload(
      group.bvid,
      group.title,
      rows.map((row) => Number(row.key)),
      naming,
    );
  }
  const items: DownloadBatchItemInput[] = rows.map((row) => ({
    kind: 'video',
    bvid: row.key,
    page: null,
    // A list's title is BETTER than the video's own and is what `clean` reads
    // a song name out of, so unlike a part it rides along.
    title: row.label,
    naming,
  }));
  return {
    target: { kind: 'new', name: group.title },
    items,
    source: listSource(group.source, group.title),
  };
}
