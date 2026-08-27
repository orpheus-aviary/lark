// The history, as React reads it (0.1.1 ⑦).
//
// The same contract `use-downloads.ts` documents: `getRecords()` hands back a
// CACHED array and builds a new one only when something changed, because
// `useSyncExternalStore` compares with `Object.is` and a store that built a
// fresh array per call would re-render forever.

import { useSyncExternalStore } from 'react';
import type { BootResult } from '../boot/sequence';
import type { DownloadRecord } from './history';
import { downloadHistoryOnce } from './history-runtime';

export function useDownloadHistory(boot: BootResult): readonly DownloadRecord[] {
  const history = downloadHistoryOnce(boot);
  return useSyncExternalStore(history.subscribe, history.getRecords);
}
