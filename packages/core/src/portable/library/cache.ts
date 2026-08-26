// Cache accounting and LRU eviction (M5-4 / M5-5), master plan §5.2.
//
// Pure logic over injected facts. Everything that is not "a row and a file on
// disk" — who is playing, who has a lease, which songs a task is about to
// write, whether a source key still resolves — arrives through options,
// because core knows nothing about the player, the HTTP layer or bilibili's
// availability policy.
//
// Two invariants carry the whole design:
//
//   1. FAIL-CLOSED (R26). A file is deleted only after its source has been
//      confirmed re-downloadable RIGHT NOW. An unreachable network and a dead
//      key look the same from here, and both mean "keep the file".
//   2. THE DELETE CRITICAL SECTION HAS NO `await` IN IT (M5-5). The probe is
//      asynchronous, so everything it observed may have changed while it ran:
//      the song can be pinned, re-keyed, re-downloaded, started playing or
//      queued for a download. So the deletion takes the song's `file` claim,
//      RE-READS the row, RE-STATS the file and RE-CHECKS every exclusion, and
//      unlinks in the same synchronous turn. Node is single-threaded: no await
//      between the re-check and the unlink means nothing can interleave.
//      Putting an await in there — any await — breaks it silently.
//
// What is deliberately NOT here: a byte ledger. Usage is measured by walking
// the song directories on every call. The library is tens to hundreds of
// songs; a ledger would be a second source of truth to keep honest.

import { eq } from 'drizzle-orm';
import type { PortableDrizzle } from '../db.js';
import type { FileContext } from '../ports/fs.js';
import { type SongRow, songs } from '../schema.js';

/** Bytes in one MiB — the unit every `*_mb` config field and wire field uses. */
export const MIB = 1024 * 1024;

/**
 * Facts the caller owns. Every predicate is called MULTIPLE times per run and
 * must answer for the state at the moment of the call, not a snapshot: status,
 * candidate pre-filtering and the pre-delete re-check all go through the same
 * ones (M5-6).
 */
export interface CacheOptions {
  /** `storage.cache_limit_mb` in bytes; 0 (or less) = unlimited. */
  limitBytes: number;
  /** Currently playing, ensure-lease holders, songs with a pending file task. */
  isExcluded: (songId: string) => boolean;
  /** Open `GET /audio` streams for this song (M5-5 ①). */
  streamCount: (songId: string) => number;
}

export interface CacheStatus {
  used_bytes: number;
  file_count: number;
  eligible_bytes: number;
  unreclaimable_bytes: number;
  limit_satisfied: boolean;
}

export interface EvictionOptions extends CacheOptions {
  /**
   * Take the song's `file` claim, or return null if someone else holds one.
   * `file` rather than `exclusive` on purpose (M5-5): a finished download
   * immediately spawns a lyrics task, and an exclusive claim would collide
   * with it — while `file` still keeps downloads, source edits and deletes out.
   */
  acquireFileClaim: (songId: string) => ClaimHandle | null;
  /** Is this key still downloadable? Anything but `true` keeps the file. */
  probe: (sourceKey: string) => Promise<boolean>;
  /**
   * Stop once THIS library's usage is at or below this many bytes (N7f).
   *
   * Defaults to `limitBytes`, which is the whole story while a device has one
   * library. It stops being the whole story when the limit is a DEVICE budget
   * shared across several: a workspace's share is not its own limit, and
   * "free 300MB from this one" is not expressible as a limit at all — 0 would
   * mean "unlimited" rather than "empty it".
   *
   * So the two are separate: `limitBytes` still says whether there is a limit,
   * and this says where this pass stops.
   */
  targetBytes?: number;
  /** Called once per deleted file, inside the run. */
  onEvicted?: (evicted: EvictedSong) => void;
  /** Cut the run short when the daemon starts stopping. */
  signal?: AbortSignal;
}

/** Opaque claim receipt — `release` is the only thing this module needs. */
export interface ClaimHandle {
  release: () => void;
}

export interface EvictedSong {
  song_id: string;
  freed_bytes: number;
}

export interface SkippedSong {
  song_id: string;
  bytes: number;
}

export interface EvictionRun {
  /** Files deleted, in eviction order. */
  evicted: EvictedSong[];
  /** Skipped because the probe could not confirm the source (fail-closed). */
  skipped_unverified: SkippedSong[];
  /** Deletion itself failed (permissions, a vanished directory). */
  failed: { song_id: string; message: string }[];
}

interface Candidate {
  row: SongRow;
  size: number;
  /** LRU key: never accessed means "as old as its creation". */
  lastUsed: number;
}

/**
 * Static eligibility (M5-4), on a row that has a file:
 * downloaded (imports are user assets and never auto-evicted, R1) + a bilibili
 * source triple to re-download from + not pinned.
 */
function isStaticallyEligible(row: SongRow): boolean {
  return (
    row.file_origin === 'downloaded' &&
    row.source_provider === 'bilibili' &&
    row.source_key !== null &&
    row.source_key !== '' &&
    !row.pinned
  );
}

/** Static eligibility plus the live exclusions. Re-evaluated, never cached. */
function isReclaimableNow(row: SongRow, opts: CacheOptions): boolean {
  return isStaticallyEligible(row) && !opts.isExcluded(row.id) && opts.streamCount(row.id) === 0;
}

function fileSize(files: FileContext, songId: string): number | null {
  return files.fs.statSync(files.paths.songAudio(songId))?.size ?? null;
}

/** Every song with an audio file on disk, with its size and LRU key. */
function scan(files: FileContext, db: PortableDrizzle): Candidate[] {
  const out: Candidate[] = [];
  for (const row of db.select().from(songs).all()) {
    const size = fileSize(files, row.id);
    if (size === null) continue;
    out.push({ row, size, lastUsed: row.last_accessed_at ?? row.created_at });
  }
  return out;
}

export function cacheStatus(
  files: FileContext,
  db: PortableDrizzle,
  opts: CacheOptions,
): CacheStatus {
  const onDisk = scan(files, db);
  let used = 0;
  let eligible = 0;
  for (const file of onDisk) {
    used += file.size;
    if (isReclaimableNow(file.row, opts)) eligible += file.size;
  }
  return {
    used_bytes: used,
    file_count: onDisk.length,
    eligible_bytes: eligible,
    unreclaimable_bytes: used - eligible,
    limit_satisfied: opts.limitBytes <= 0 || used <= opts.limitBytes,
  };
}

/**
 * Delete downloaded files, least recently used first, until usage fits the
 * limit or the candidates run out. The DB row and `lyrics.lrc` always stay:
 * evicting a song means "the audio can be fetched again", not "forget it".
 */
export async function runEviction(
  files: FileContext,
  db: PortableDrizzle,
  opts: EvictionOptions,
): Promise<EvictionRun> {
  const run: EvictionRun = { evicted: [], skipped_unverified: [], failed: [] };
  // No explicit target means the limit is the target — and no limit means
  // nothing to do, which is what every single-library caller has always meant.
  if (opts.targetBytes === undefined && opts.limitBytes <= 0) return run;
  const target = opts.targetBytes ?? opts.limitBytes;

  const onDisk = scan(files, db);
  let used = onDisk.reduce((sum, f) => sum + f.size, 0);
  if (used <= target) return run;

  const candidates = onDisk
    .filter((f) => isReclaimableNow(f.row, opts))
    .sort((a, b) => a.lastUsed - b.lastUsed || (a.row.id < b.row.id ? -1 : 1));

  for (const candidate of candidates) {
    if (used <= target) break;
    if (opts.signal?.aborted === true) break;

    const songId = candidate.row.id;
    const probedKey = candidate.row.source_key;
    if (probedKey === null) continue; // unreachable: eligibility required a key

    // The one await in the loop. Everything below re-derives its facts.
    const usable = await opts.probe(probedKey);
    if (!usable) {
      run.skipped_unverified.push({ song_id: songId, bytes: candidate.size });
      continue;
    }

    // ─── Critical section: no `await` past this line (M5-5) ───
    const claim = opts.acquireFileClaim(songId);
    if (claim === null) continue; // a writer has it; try again next round
    try {
      const fresh = db.select().from(songs).where(eq(songs.id, songId)).get();
      if (fresh === undefined) continue; // deleted while we probed
      if (!isReclaimableNow(fresh, opts)) continue; // pinned / playing / queued
      if (fresh.source_key !== probedKey) continue; // re-keyed: probe proved nothing
      const size = fileSize(files, songId); // re-stat: it may have been replaced
      if (size === null) continue;

      // Synchronous, like the re-checks above it: the port's `unlinkSync` is
      // what keeps this whole section free of `await` (M5-5).
      files.fs.unlinkSync(files.paths.songAudio(songId));
      used -= size;
      const evicted: EvictedSong = { song_id: songId, freed_bytes: size };
      run.evicted.push(evicted);
      opts.onEvicted?.(evicted);
    } catch (err) {
      run.failed.push({
        song_id: songId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // try/finally, not a trailing call: a throw in the re-check, the stat or
      // the unlink would otherwise leak the claim forever — nothing here has
      // the engine's `releaseOwner` safety net (M5-5).
      claim.release();
    }
  }

  return run;
}
