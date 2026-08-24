// The cache model, assembled for this phone (N4g-1, §1.4).
//
// The daemon's half of this is `daemon/src/cache.ts` and it is the same shape:
// the LOOP is portable (`EvictionScheduler`, `SongLeaseRegistry`,
// `canRedownload` — N4a, decision g), and each host supplies who is playing,
// who may write a song directory, and how to ask bilibili whether a file can
// be fetched again. Two scheduling semantics written twice would drift, and the
// shape of that drift is "the same download evicted on one device and not the
// other".
//
// THREE THINGS THIS HOST ANSWERS DIFFERENTLY, all of them in `defer`, `probe`
// and `signal`:
//
//   `defer` is `setTimeout(fn, 0)` where the desktop passes `setImmediate`
//   (decision c). The property being bought is the same one and the only one:
//   a MACROTASK, so that a drain triggered from a download's `onSucceeded`
//   starts after the task's file claim is released a microtask later. A
//   microtask here would find the just-downloaded song busy, skip it, and
//   never come back (M5-6).
//
//   `probe` carries no `shutdownSignal`, only its own deadline. Which is the
//   third difference:
//
//   `signal` is a signal that never fires. The desktop's is the daemon asking
//   itself to stop, which a phone has no equivalent of — Android kills the
//   process, it does not ask. Written down rather than left as a mystery
//   `new AbortController()`.

import {
  type BilibiliClient,
  type CacheOptions,
  DEFAULT_TIMEOUTS,
  type DownloadEngine,
  type DownloadTimeouts,
  EvictionScheduler,
  type EvictionSummary,
  type FileContext,
  type PipelineDeps,
  type PortableDb,
  SongLeaseRegistry,
  canRedownload,
  uuid,
  withTimeout,
} from '@lark/core/portable';
import { engineLogger } from '../downloads/log';
import { libraryChanged } from '../library-signal';
import { createCacheOptions } from '../services/library';

/**
 * Nothing on a phone corresponds to the daemon's shutdown (see the header).
 * A drain is cut short by the process ending, which needs no cooperation.
 */
const NEVER_ABORTED = new AbortController().signal;

export interface CacheRuntimeDeps {
  db: PortableDb;
  files: FileContext;
  /** The engine, for its claim registry and its pending-file set. */
  engine: DownloadEngine;
  /** The engine's client, not a second one — one anonymous identity per app. */
  bilibili: BilibiliClient;
  timeouts?: DownloadTimeouts;
  /** The song the player is on (`player.getState().song`). */
  currentSongId: () => string | null;
}

export interface CacheRuntime {
  /**
   * Eviction immunity for a file that just landed and is not protected yet
   * (M5-6). Granted by the engine assembly when an `ensure-file` succeeds.
   *
   * NOTHING CLEARS IT HERE, unlike the desktop, and that is not an omission:
   * the desktop clears the lease when the audio STREAM opens, because from
   * then on the stream is the protection. This phone has no stream — what
   * follows an ensure is the player making that song the current one, which
   * excludes it for as long as it is playing. So the lease simply runs out,
   * sixty seconds after the file arrived, which is exactly the window it
   * exists to cover.
   */
  leases: SongLeaseRegistry;
  /** Fresh per call — see `createCacheOptions`. */
  options: () => CacheOptions;
  /**
   * Ask for a drain and walk away. The three background triggers (§2.2):
   * boot, a finished download, and a changed limit.
   */
  schedule: (reason: string) => void;
  /**
   * Ask for a drain and wait for the numbers. ONE caller: 设置's 「立即清理」,
   * the only place a person is shown what a drain did (decision e).
   */
  run: () => Promise<EvictionSummary>;
}

export function createCacheRuntime(deps: CacheRuntimeDeps): CacheRuntime {
  const leases = new SongLeaseRegistry();
  const timeouts = deps.timeouts ?? DEFAULT_TIMEOUTS;

  const options = (): CacheOptions =>
    createCacheOptions({
      sqlite: deps.db.sqlite,
      currentSongId: deps.currentSongId,
      hasLease: (songId) => leases.has(songId),
      pendingFileSongIds: () => deps.engine.pendingFileSongIds(),
      logger: engineLogger,
    });

  const pipeline: PipelineDeps = {
    store: deps.db,
    files: deps.files,
    bilibili: deps.bilibili,
    // A probe confirms the STORED key and never re-identifies, so it has no
    // business with a model even on an install that has one configured.
    llm: null,
    timeouts,
    logger: engineLogger,
  };

  const scheduler = new EvictionScheduler({
    files: deps.files,
    db: deps.db.drizzle,
    cacheOptions: options,
    acquireFileClaim: (songId) => {
      try {
        const token = deps.engine.claims.acquire(songId, 'file', `cache:${uuid()}`);
        return { release: () => deps.engine.claims.release(token) };
      } catch {
        return null; // SongBusyError: someone else is writing this song
      }
    },
    probe: (sourceKey) =>
      canRedownload(pipeline, sourceKey, {
        signal: withTimeout(timeouts.bilibiliMeta),
        reportStage: () => {},
      }),
    // A row's `has_file` just changed with nobody's finger on a button — the
    // same situation a finished download is in, and the same signal it sends
    // (`library-signal.ts`). Without it the list keeps offering to play a file
    // that is no longer there.
    onEvicted: () => libraryChanged(),
    onDeleteFailed: (song_id, err) =>
      engineLogger.warn({ song_id, err }, 'could not delete a cached file'),
    signal: NEVER_ABORTED,
    defer: (fn) => {
      setTimeout(fn, 0);
    },
    onBackgroundError: (err) => engineLogger.error({ err }, 'cache eviction failed (late trigger)'),
  });

  return {
    leases,
    options,
    schedule: (reason) => {
      void scheduler.schedule().catch((err: unknown) => {
        engineLogger.error({ err, reason }, 'cache eviction failed');
      });
    },
    run: () => scheduler.schedule(),
  };
}
