// The library service, assembled for this phone (N2e).
//
// There is nothing here but wiring, and that is the point: every rule about
// what the library accepts — trimming, caps, the id gate, whether `all` is
// writable — is in `@lark/core/portable`'s `createLibraryService`, which the
// daemon and the CLI also call. The three front ends stopped agreeing exactly
// when each of them wrote those rules out for itself (§7 F13, and the two M6
// cases), and the LibraryContract is what catches it happening again.
//
// The dependencies are handed in rather than built here. `fileOps` especially:
// `deleteSong` drains the journal unconditionally, so a second runtime over the
// same rows would arbitrate song files against a second claim registry — which
// is the race the registry exists to prevent. Since N4b the one to pass is the
// download runtime's, which shares the ENGINE's registry; the boot sequence's
// own runtime has finished draining by then and arbitrates with nobody.

import {
  type CacheOptions,
  type DeviceSettingsPort,
  type FileEffectRuntime,
  type LibraryService,
  MIB,
  type StructuredLogger,
  createLibraryService,
  readCacheLimitMb,
} from '@lark/core/portable';
import type { BootResult } from '../boot/sequence';

export function createLibrary(boot: BootResult, fileOps: FileEffectRuntime): LibraryService {
  return createLibraryService({
    db: boot.db,
    files: boot.files,
    fileOps,
    // Decision i. `audioMode` exists because a 0.2.x desktop library can still
    // hold `song.mp3` while its migration is pending; a phone has never had
    // one — schema v3 or the boot sequence refuses the library outright.
    audioMode: 'canonical',
  });
}

/**
 * What this phone answers when the library asks who may be evicted (§1.4).
 *
 * CALL IT PER USE, never once at assembly. Two of the three answers change
 * inside one process — the limit when somebody edits it, the exclusion set
 * whenever a song starts playing or a task starts writing — and
 * `EvictionScheduler` takes a THUNK for exactly this reason: it evaluates one
 * of these per round, so a snapshot would act on a world that has moved.
 *
 * The three exclusions are the phone's reading of the desktop's (M5-5):
 *
 *   the song the player is on — trusted however old, because the conservative
 *     direction is "do not delete what might be playing";
 *   an ensure lease — a file that just landed for a play that has not started
 *     yet, protected for 60 seconds (`SongLeaseRegistry`);
 *   a pending file task — a song a queued or running download is about to
 *     write, which the engine already tracks for the desktop.
 *
 * `streamCount` is the one that differs, and it is honestly 0 rather than
 * unimplemented: the desktop counts open `GET /audio` responses because its
 * renderer plays through HTTP. ExoPlayer opens the file itself, so there is no
 * stream to count and never will be one here.
 */
export interface CacheOptionsDeps {
  /** Where the limit lives since N7a: this phone, not this library. */
  settings: DeviceSettingsPort;
  /** The song the player is on, playing or paused. `null` when it has none. */
  currentSongId: () => string | null;
  /** `SongLeaseRegistry.has` — the 60-second window after an ensure-file. */
  hasLease: (songId: string) => boolean;
  /** `engine.pendingFileSongIds()` — songs a live task will write a file for. */
  pendingFileSongIds: () => ReadonlySet<string>;
  /** Where "your limit is not a number I can use" goes (`downloads/log.ts`). */
  logger?: StructuredLogger;
}

export function createCacheOptions(deps: CacheOptionsDeps): CacheOptions {
  return {
    limitBytes: readCacheLimitMb(deps.settings, deps.logger) * MIB,
    isExcluded: (songId) =>
      deps.currentSongId() === songId ||
      deps.hasLease(songId) ||
      deps.pendingFileSongIds().has(songId),
    streamCount: () => 0,
  };
}
