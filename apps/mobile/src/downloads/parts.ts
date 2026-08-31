// The parts of one multi-part video, as rows to pick from (0.5.1 §7.3, §7.6).
//
// 🔴 THE PHONE ASKS BILIBILI ITSELF. This is the difference between the two
// ends that the protocol bump exists for: the desktop has to go through the
// daemon (`POST /download/parts`), and the phone already holds a bilibili
// client, so it calls portable's `fetchParts` directly and needs no endpoint
// at all.
//
// Keyed by the page number, because that is what goes back as `?p=` — and
// unlike a folder, a video cannot hold the same part twice, so there is
// nothing to collapse (`selection.ts`'s `pickable` is about the other case).

import { type BilibiliClient, fetchParts } from '@lark/core/portable';
import type { DownloadBatchItemInput, DownloadNamingMode, DownloadPartsData } from '@lark/shared';
import type { PickRow } from './selection';

export interface PartRow extends PickRow {
  page: number;
}

/** `M:SS`, or `null` when bilibili did not say — a row showing 0:00 is worse. */
function duration(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) return null;
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function partRows(data: DownloadPartsData): PartRow[] {
  return data.parts.map((part) => ({
    key: String(part.page),
    page: part.page,
    // A part with no title of its own still needs a name to tick.
    label: part.part === '' ? `P${part.page}` : part.part,
    note: duration(part.duration),
    // A part is never refused: it is already in the video's own page list.
    reason: null,
  }));
}

export async function loadParts(
  client: BilibiliClient,
  bvid: string,
  signal?: AbortSignal,
): Promise<DownloadPartsData> {
  return fetchParts(client, bvid, signal === undefined ? undefined : { signal });
}

/**
 * The picked rows, in wire shape.
 *
 * `title: null` on every one: the pipeline reads the part's own title out of
 * the page list it fetches anyway (§7.4), and two sources for one string
 * drift. The desktop sends exactly this.
 */
export function partItems(
  bvid: string,
  rows: readonly PartRow[],
  naming: DownloadNamingMode,
): DownloadBatchItemInput[] {
  return rows.map((row) => ({ kind: 'video', bvid, page: row.page, title: null, naming }));
}
