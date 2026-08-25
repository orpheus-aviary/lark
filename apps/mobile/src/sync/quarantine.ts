// How many songs a peer's delete parked in `recovered-songs/` (N5c).
//
// `CoordinatorContext.countQuarantined` is injected rather than imported for
// exactly this reason: counting them is a filesystem question, and the status
// builder is otherwise pure database + memory. The desktop reads the directory
// with `node:fs`; this reads it with expo-file-system, and the ONE line that
// differs between the hosts is which one.
//
// Synchronous, because the port is (`() => number`) and expo-file-system's
// modern API is too. It runs on every `buildSyncStatus`, which is every status
// read and every round transition — a directory listing of something that is
// almost always empty, and the alternative is a cached number that lies after
// the first quarantine of the session.

import { recoveredSongsRoot } from '../ports/paths';

/**
 * Directories under `recovered-songs/`, one per quarantined song.
 *
 * A missing root is zero, not an error: the directory is created by the first
 * quarantine and most installs never have one. Anything else that goes wrong
 * reading it is also zero — a status endpoint that throws is a status nobody
 * can read, and this is the least important number on it.
 */
export function countQuarantined(): number {
  try {
    const root = recoveredSongsRoot();
    if (!root.exists) return 0;
    // Files directly under the root are not songs — the journal only ever
    // moves whole directories here (`quarantineSongDir`) or creates one to
    // move a file into (`quarantineSongFile`).
    return root.list().filter((entry) => 'list' in entry).length;
  } catch {
    return 0;
  }
}
