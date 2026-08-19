// The library service, assembled for this phone (N2e).
//
// There is nothing here but wiring, and that is the point: every rule about
// what the library accepts — trimming, caps, the id gate, whether `all` is
// writable — is in `@lark/core/portable`'s `createLibraryService`, which the
// daemon and the CLI also call. The three front ends stopped agreeing exactly
// when each of them wrote those rules out for itself (§7 F13, and the two M6
// cases), and the LibraryContract is what catches it happening again.
//
// All four dependencies come from the boot sequence rather than being built
// here. `fileOps` especially: `deleteSong` drains the journal unconditionally,
// so a second runtime over the same rows would arbitrate song files against a
// second claim registry — which is the race the registry exists to prevent.

import { type CacheOptions, type LibraryService, createLibraryService } from '@lark/core/portable';
import type { BootResult } from '../boot/sequence';

export function createLibrary(boot: BootResult): LibraryService {
  return createLibraryService({
    db: boot.db,
    files: boot.files,
    fileOps: boot.fileOps,
    // Decision i. `audioMode` exists because a 0.2.x desktop library can still
    // hold `song.mp3` while its migration is pending; a phone has never had
    // one — schema v3 or the boot sequence refuses the library outright.
    audioMode: 'canonical',
  });
}

/**
 * `cacheStatus` / `runEviction` options for a build with no player (N2).
 *
 * Both exclusions answer for things that do not exist yet — the player lands
 * in N3, audio streams in N4 — so they are honest `false`/`0` rather than
 * placeholders that will quietly stay wrong once those do exist. `limitBytes:
 * 0` means unlimited, which is what a phone with no configured limit means.
 *
 * The cache FEATURE is N4's. This exists because the LibraryContract's cache
 * case is part of N2's gate: the method has to be callable now, whatever is
 * built on it later.
 */
export const NO_PLAYER_CACHE_OPTIONS: CacheOptions = {
  limitBytes: 0,
  isExcluded: () => false,
  streamCount: () => 0,
};
