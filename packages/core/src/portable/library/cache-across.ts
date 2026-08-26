// One budget, several libraries (N7f, §2.6).
//
// The cache limit is a DEVICE setting — it says how much room lark may take on
// this machine — so once a device holds several workspaces the accounting has
// to span them. Two consequences, and the second is the one that needed
// deciding:
//
//   the settings page reports THIS workspace and the others separately, and
//     the two add up to every byte of lark audio on the disk (criterion 119);
//   a drain frees the OTHER workspaces first, and only then touches the one
//     somebody is looking at (criterion 120, the user's decision).
//
// 🔴 A FOREIGN WORKSPACE IS READ AND ITS FILES ARE UNLINKED. Nothing else.
// `runEviction` only ever SELECTs — `has_file` is a disk probe, not a column,
// so there is no row to update after a delete — and that is what makes it
// safe to point at a library this process does not own (criterion 121).
// Opening it is the host's job; the host is also what decides whether that
// open can be read-only.
//
// EVERY INVARIANT IS THE SAME ONE, because it is the same function. Imported
// files are never evicted (R1), a source that cannot be confirmed
// re-downloadable keeps its file (R26), pinned stays, LRU order stands. A
// second implementation for "other people's libraries" is exactly how those
// would drift.
//
// WHAT IS DIFFERENT ABOUT A FOREIGN WORKSPACE, and why it is safe: nothing in
// it can be playing, streaming or mid-download, because one process opens one
// library. So its live exclusions are constant `false` and its claim registry
// has nobody to arbitrate with. The static rules do all the work.

import type { PortableDrizzle } from '../db.js';
import type { FileContext } from '../ports/fs.js';
import {
  type CacheOptions,
  type CacheStatus,
  type EvictionOptions,
  type EvictionRun,
  cacheStatus,
  runEviction,
} from './cache.js';

/** One library, opened by the host, with the paths that belong to it. */
export interface WorkspaceLibrary {
  id: string;
  files: FileContext;
  db: PortableDrizzle;
}

export interface AcrossStatus {
  /** The workspace this process opened — what every screen is about. */
  current: CacheStatus;
  /** Every other workspace's audio, added up. */
  other_bytes: number;
  other_files: number;
  /** `current.used_bytes + other_bytes` — all of lark's audio on this device. */
  total_bytes: number;
  /** Whether the DEVICE is inside its limit, which is the only limit there is. */
  limit_satisfied: boolean;
}

/**
 * What the settings page reports.
 *
 * The other workspaces are measured with the same walk and the same rules,
 * with their live exclusions constant — see the header for why that is not a
 * shortcut.
 */
export function cacheStatusAcross(
  current: WorkspaceLibrary,
  others: readonly WorkspaceLibrary[],
  opts: CacheOptions,
): AcrossStatus {
  const here = cacheStatus(current.files, current.db, opts);
  let otherBytes = 0;
  let otherFiles = 0;
  for (const workspace of others) {
    const status = cacheStatus(workspace.files, workspace.db, foreign(opts));
    otherBytes += status.used_bytes;
    otherFiles += status.file_count;
  }
  const total = here.used_bytes + otherBytes;
  return {
    current: here,
    other_bytes: otherBytes,
    other_files: otherFiles,
    total_bytes: total,
    limit_satisfied: opts.limitBytes <= 0 || total <= opts.limitBytes,
  };
}

export interface AcrossEvictionRun {
  /** What each workspace gave up, keyed by id. `current` is included. */
  runs: { id: string; run: EvictionRun }[];
  freed_bytes: number;
  /** Usage across every workspace after the pass. */
  total_bytes: number;
}

export interface AcrossEvictionOptions extends EvictionOptions {
  /** Every workspace on this device except the one this process opened. */
  others: readonly WorkspaceLibrary[];
}

/**
 * Bring the DEVICE inside its limit, other workspaces first.
 *
 * 🔴 THE ORDER IS THE USER'S DECISION (§2.6) and it is the kind one: the
 * library somebody is looking at keeps its files for as long as possible, and
 * what goes first is audio belonging to an account they are not currently
 * using — which is also the audio they are least likely to press play on in
 * the next minute.
 *
 * Within each workspace the order is unchanged: least recently used first,
 * fail-closed on the probe.
 */
export async function runEvictionAcross(
  current: WorkspaceLibrary,
  opts: AcrossEvictionOptions,
): Promise<AcrossEvictionRun> {
  const runs: { id: string; run: EvictionRun }[] = [];
  const measure = (workspace: WorkspaceLibrary, options: CacheOptions): number =>
    cacheStatus(workspace.files, workspace.db, options).used_bytes;

  const foreignOpts = foreign(opts);
  let total = measure(current, opts);
  for (const workspace of opts.others) total += measure(workspace, foreignOpts);

  if (opts.limitBytes <= 0 || total <= opts.limitBytes) {
    return { runs, freed_bytes: 0, total_bytes: total };
  }

  let remaining = total - opts.limitBytes;
  const before = total;

  for (const workspace of opts.others) {
    if (remaining <= 0) break;
    if (opts.signal?.aborted === true) break;
    const used = measure(workspace, foreignOpts);
    const run = await runEviction(workspace.files, workspace.db, {
      ...opts,
      ...foreign(opts),
      // Free at most what is still owed — never more of somebody else's
      // library than the device actually needs back.
      targetBytes: Math.max(0, used - remaining),
    });
    const freed = run.evicted.reduce((sum, entry) => sum + entry.freed_bytes, 0);
    remaining -= freed;
    total -= freed;
    runs.push({ id: workspace.id, run });
  }

  if (remaining > 0 && opts.signal?.aborted !== true) {
    const used = measure(current, opts);
    const run = await runEviction(current.files, current.db, {
      ...opts,
      targetBytes: Math.max(0, used - remaining),
    });
    const freed = run.evicted.reduce((sum, entry) => sum + entry.freed_bytes, 0);
    total -= freed;
    runs.push({ id: current.id, run });
  }

  return { runs, freed_bytes: before - total, total_bytes: total };
}

/**
 * A foreign workspace's live exclusions: there are none.
 *
 * One process opens one library, so nothing in another workspace is playing,
 * streaming or being written — and its claim registry has nobody to arbitrate
 * with. Spelled out rather than inherited, because inheriting THIS process's
 * exclusions would silently protect a song in one library because a song with
 * the same id is playing in another.
 */
function foreign(
  opts: CacheOptions,
): CacheOptions & { acquireFileClaim: () => { release: () => void } } {
  return {
    limitBytes: opts.limitBytes,
    isExcluded: () => false,
    streamCount: () => 0,
    acquireFileClaim: () => ({ release: () => {} }),
  };
}
