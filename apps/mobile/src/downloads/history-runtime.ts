// The download history, wired to this process (0.1.1 ⑦).
//
// Same split as the ensure controller beside it: `history.ts` is the store
// with `load`/`save` injected and no React Native anywhere in it, and this is
// where it meets the two things it cannot reach on its own — the file, and the
// hub that says when a task finished.
//
// A SINGLETON, like everything else in here (`bootOnce`, the player, the
// engine, the ensure controller). Android rebuilds the Activity and every
// screen remounts; a second store would be a second `known` set, and the two
// would put each other's deleted rows back.
//
// SUBSCRIBED HERE rather than inside the factory, for the reason the ensure
// controller is: a factory with a subscription is a factory with a side effect
// nothing can undo, and `history.ts` has to stay loadable without a device.
//
// 🔴 AND CALLED FROM `App.tsx`, NOT FROM THE SCREEN. The subscription starts
// when this is first built, so building it lazily would mean a download that
// finished before anybody opened 添加 was never recorded — and tapping a song
// with no file starts one from 歌曲.

import type { BootResult } from '../boot/sequence';
import { createFileSystem } from '../ports/fs';
import { downloadHistoryFile } from '../ports/paths';
import { type DownloadHistory, createDownloadHistory } from './history';
import { downloads } from './hub';
import { engineLogger } from './log';

let history: DownloadHistory | null = null;

/**
 * @param _boot unused, and asked for anyway: it is the proof that the library
 * is open. Every path below hangs off the workspace the boot sequence
 * resolved, and asking earlier would read — and cache — one that is not the
 * one this launch serves (`ports/paths.ts`).
 */
export function downloadHistoryOnce(_boot: BootResult): DownloadHistory {
  if (history === null) {
    const fs = createFileSystem();
    const built = createDownloadHistory({
      // The three lines that touch the disk. They are here and not in
      // `history.ts` so that what a missing or corrupt file MEANS stays in a
      // file Node can load.
      load: () => {
        const file = downloadHistoryFile();
        return file.exists ? file.textSync() : null;
      },
      save: (text) => fs.writeTextAtomic(downloadHistoryFile().uri, text),
      logger: engineLogger,
    });
    // Every terminal task, once. `observe` is idempotent, so a tick per
    // progress event costs a `Set.has` per task and nothing else.
    downloads.subscribe(() => built.observe(downloads.getState().tasks));
    built.observe(downloads.getState().tasks);
    history = built;
  }
  return history;
}
