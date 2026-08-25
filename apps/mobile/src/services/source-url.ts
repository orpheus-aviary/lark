// What a pasted link becomes, assembled for this phone (N4i-2).
//
// Both functions are `@lark/core/portable`'s (`download/source-url.ts`, N4i-1)
// — the same six branches the desktop's `PUT /songs/:id` and its [自动识别]
// button run. What a host supplies is one thing: a bilibili client.
//
// AND IT IS THE ENGINE'S CLIENT, never a second one. A second client is a
// second anonymous buvid and a second WBI key cache — two identities for one
// app, refetching the same keys — which is the shape the add page's preflight
// already settled on in N4d (`DownloadRuntime.bilibili`).

import {
  type RecognizedSource,
  type SourceTriple,
  recognizeSourceUrl,
  resolveSourceUrl,
} from '@lark/core/portable';
import type { DownloadRuntime } from '../downloads/engine';

export type { RecognizedSource };

/**
 * The triple to store for this url. Throws `InvalidSourceError` for something
 * that is not a link at all; the caller shows that sentence as it is.
 */
export function resolveLink(
  runtime: DownloadRuntime,
  url: string | null,
  signal?: AbortSignal,
): Promise<SourceTriple> {
  return resolveSourceUrl(runtime.bilibili, url, signal === undefined ? undefined : { signal });
}

/**
 * What this url IS, without writing anything — the 自动识别 step.
 *
 * Stricter than the save path by design (only a video answers), because its
 * whole purpose is to show a title before you commit. On a phone that is worth
 * more than on the desktop: the link usually arrived through a share sheet and
 * there is nothing on screen to check it against.
 */
export function recogniseLink(
  runtime: DownloadRuntime,
  url: string,
  signal?: AbortSignal,
): Promise<RecognizedSource> {
  return recognizeSourceUrl(runtime.bilibili, url, signal === undefined ? undefined : { signal });
}
