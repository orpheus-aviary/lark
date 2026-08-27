// How much room lark takes on this PHONE (N7f; extracted in 0.1.1 ⑤).
//
// 🔴 THE LIMIT IS A DEVICE SETTING, so the figure it is judged against has to
// be every library on the device — `CacheStatusData` says as much, and an
// eviction frees the ones nobody is looking at first (`INVARIANTS` §5.6). A
// caller that counted only the library on screen would say this phone is
// inside a limit it is over.
//
// EXTRACTED because there are two callers now and they must not disagree: the
// settings page shows this number, and the playlist batch refuses to go past
// it (`downloads/budget.ts`). Two walks with two rules would be two different
// answers to 「还有多少空间」, and only one of them would be on screen.
//
// Wiring, not judgement: it opens other workspaces and walks directories, so
// it cannot load under Node. What it feeds is pure and tested.

import { type CacheOptions, type CacheStatus, cacheStatus } from '@lark/core/portable';
import { openForeignWorkspaces } from '../workspace/foreign';

export interface DeviceUsage {
  /** The library this launch opened. */
  here: CacheStatus;
  /** Every other library on the phone, added up. */
  otherBytes: number;
  otherFiles: number;
  /** What the limit is actually judged against. */
  usedBytes: number;
}

export function readDeviceUsage(deps: {
  /** `view.cacheStatus` — the library on screen, through the live reader. */
  statusHere: (options: CacheOptions) => CacheStatus;
  options: CacheOptions;
  /** The workspace this launch opened; every other one is walked. */
  workspace: string;
}): DeviceUsage {
  const here = deps.statusHere(deps.options);
  const opened = openForeignWorkspaces(deps.workspace);
  let otherBytes = 0;
  let otherFiles = 0;
  try {
    for (const workspace of opened.workspaces) {
      // No exclusions and no limit: this is an accounting walk over a library
      // nothing in this process is playing from or writing to.
      const each = cacheStatus(workspace.files, workspace.db, {
        limitBytes: 0,
        isExcluded: () => false,
        streamCount: () => 0,
      });
      otherBytes += each.used_bytes;
      otherFiles += each.file_count;
    }
  } finally {
    opened.close();
  }
  return { here, otherBytes, otherFiles, usedBytes: here.used_bytes + otherBytes };
}
