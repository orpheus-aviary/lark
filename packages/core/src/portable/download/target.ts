// What a task is trying to download (M3), on its own.
//
// Extracted from `pipeline.ts` in N1b for a boring structural reason: two
// modules that have nothing to do with the pipeline — the task record and the
// batch registry — need this type, and importing it from `pipeline.ts` drags
// ffmpeg, `node:stream` and the whole download machinery into their graph. The
// type is a description of a REQUEST; it belongs where anyone can name it.

import type { DownloadNamingMode } from '@lark/shared';

/** What a task is trying to download, after the route's deterministic parse. */
export type DownloadTarget =
  | {
      kind: 'video';
      bvid: string;
      page: number | null;
      title: string | null;
      naming: DownloadNamingMode;
    }
  | { kind: 'keyword'; query: string };
