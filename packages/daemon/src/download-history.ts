// The download record, on disk (0.5.0 ④ / P8b).
//
// WHAT THIS REPLACES. Until now the desktop's 「已结束」 section was a view of
// the engine's in-memory ring — the dialog said so in as many words ("这次运行
// 里已经结束的任务") — so closing the app was enough to lose the answer to
// "what happened to that download". The phone has kept a file since 0.1.1 ⑦,
// and ④ asked for the two ends to work the same way.
//
// THE STORE IS PORTABLE'S (P8a moved it there); this file is the three things
// it cannot reach on its own: the path, the filesystem, and the engine event
// that says a task finished. That split is the phone's `history-runtime.ts`,
// one host over.
//
// LOADED SYNCHRONOUSLY, and that is not a compromise. The store reads its file
// once, in its constructor, so that the first render has the rows — the same
// contract the phone's expo-file-system `File.text()` satisfies. Here that is
// a `readFileSync` of at most 200 entries, at activation, next to the SQLite
// open that just happened on the same thread.

import { readFileSync } from 'node:fs';
import {
  type DownloadHistory,
  type FileContext,
  type StructuredLogger,
  createDownloadHistory,
} from '@lark/core/portable';

export interface DownloadHistoryOptions {
  /** `<workspace>/downloads.json`, from the one place that says where that is. */
  path: string;
  files: FileContext;
  logger: StructuredLogger;
}

export function createNodeDownloadHistory(options: DownloadHistoryOptions): DownloadHistory {
  return createDownloadHistory({
    load: () => {
      try {
        return readFileSync(options.path, 'utf-8');
      } catch (err) {
        // A history that is not there is not an error — it is a library
        // nothing has finished downloading in yet. Everything else propagates
        // into the store, which logs it and starts the launch with none.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    save: (text) => options.files.fs.writeTextAtomic(options.path, text),
    logger: options.logger,
  });
}
