// The phone's `AudioLandingPort` (N4b, subplan §2.3).
//
// The desktop streams to a temp file, transcodes with ffmpeg, probes the
// output and lands it through a six-step protocol with a `.pending` manifest
// that survives kill -9. This device does none of that: it stores bilibili's
// fMP4 as it arrives (D17 — no remux, and a non-AAC stream is refused rather
// than transcoded), reads the duration with MediaMetadataRetriever, and swaps
// the file in with one atomic move.
//
// It reverses the desktop's order on purpose (decision c). The desktop commits
// the row AFTER the file is in place, protected by the manifest; here the row
// is committed FIRST and the file swapped after. The manifest exists to keep an
// irreplaceable old file safe, and on this device there is no such file — every
// audio file came from a download and can come again (no local import, D12). So
// the simpler self-healing shape wins:
//
//   ① songs/<id>/ mkdir (new song)
//   ② refuse a non-AAC stream, before a byte moves (§1.7)
//   ③ download natively → .download.<taskId>.tmp
//  ③b every byte the source promised actually arrived
//   ④ read the landed duration (MMR); unreadable = do not commit
//   ⑤ commit the row + touch last_accessed, in one transaction — no going back
//   ⑥ atomically replace song.m4a with the tmp file
//
// ③b IS NOT REDUNDANT WITH ④, and criterion 7② is why it exists. The plan
// assumed an incomplete download would have no readable duration. It does:
// bilibili's fragmented MP4 carries its `moov` at the FRONT, so 64KB of a
// 3.7MB track reads back the full 136.8 seconds (measured on the frozen
// device). "Decodable" and "complete" are different questions, and a transfer
// that stopped early is only ever about the second one.
//
// Everything before ⑤ undoes itself on the way out: the tmp goes, and a `new`
// song's directory goes with it, because a brand-new song owns nothing else in
// there and what is left would read as an orphan to the boot sweep. The old
// file needs no restoring — it is never touched until ⑥.
//
// A crash between ⑤ and ⑥ leaves a committed row with no canonical file (new →
// "needs download", one tap self-heals) or the old file (replace → plays on,
// duration off by seconds until the next redownload). Both are written into the
// plan's crash table as the cost of not carrying a manifest.

import {
  type AudioLandingInput,
  type AudioLandingPort,
  AudioNotAacError,
  BilibiliApiError,
  CANONICAL_AUDIO_FILE,
  DownloadCommitError,
  type PortableDb,
  touchLastAccessed,
  withTimeout,
} from '@lark/core/portable';
import { File } from 'expo-file-system';
import LarkFs from '../../modules/lark-fs';
import LarkMedia from '../../modules/lark-media';
import { songDirectory } from './paths';

/**
 * The download itself, as a seam (§2.1). Default is expo-file-system's native
 * `downloadFileAsync`, which streams the body straight to disk rather than
 * through JS (decision a). The acceptance build substitutes one that writes a
 * truncated or empty file, because there is no way to make a real transfer
 * arrive corrupt inside one app-private directory (criterion 7②).
 */
export type AudioTransfer = (args: {
  request: AudioLandingInput['request'];
  destinationUri: string;
  onProgress: (received: number, total: number | null) => void;
  signal: AbortSignal;
}) => Promise<void>;

export interface MobileAudioLandingDeps {
  store: PortableDb;
  /** Default: native `downloadFileAsync`. */
  transfer?: AudioTransfer;
  /** Read a landed file's duration in seconds. Default: lark-media (MMR). */
  readDuration?: (uri: string) => Promise<number>;
  /** The atomic replace. Default: lark-fs (`Files.move` REPLACE + ATOMIC). */
  moveAtomic?: (from: string, to: string) => Promise<void>;
  /**
   * Acceptance builds only: called between ⑤ and ⑥, so criterion 11 can stop
   * the process exactly where the crash table says the interesting state is —
   * the row committed, the file not yet in place.
   *
   * A throw would not do. That state is the one thing this protocol trades the
   * desktop's manifest for, and a throw unwinds where SIGKILL does not: the
   * point is what the NEXT boot makes of a directory holding one `.tmp` and a
   * row that already exists. Same shape as `boot/sequence.ts`'s crash points
   * and the file-op journal's, third time (decision o⑤: chosen, not guessed).
   */
  crashPoint?: () => void | Promise<void>;
}

/** `.download.<taskId>.tmp`, a sibling of `song.m4a`, swept by boot if orphaned. */
const downloadTmpName = (taskId: string): string => `.download.${taskId}.tmp`;

/**
 * The real thing, exported so acceptance can wrap it rather than replace it
 * (criterion 6 counts what it reports without changing what it does).
 */
export const nativeAudioTransfer: AudioTransfer = async ({
  request,
  destinationUri,
  onProgress,
  signal,
}) => {
  await File.downloadFileAsync(request.url, new File(destinationUri), {
    // A mutable copy: the port's headers are readonly, and the download API
    // takes a plain index signature.
    headers: { ...request.headers },
    // The tmp path may already exist from a retry; overwrite rather than fail.
    idempotent: true,
    onProgress: ({ bytesWritten, totalBytes }) =>
      onProgress(bytesWritten, totalBytes >= 0 ? totalBytes : null),
    signal,
  });
};

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The C cross-check (§1.4), and it is a REMARK, not a verdict.
 *
 * The upstream page duration cannot prove the file decodes, so it never
 * decides anything and never reaches the row — but a landed file that is three
 * seconds off what bilibili said it would be is worth a line in the log. Whole
 * upstream seconds and multi-part videos make small gaps ordinary, which is
 * where the three comes from.
 */
function quotedDurationWarnings(duration: number, expected: number | null): string[] {
  if (expected === null || Math.abs(duration - expected) <= 3) return [];
  return [`landed duration ${duration.toFixed(1)}s differs from upstream ${expected}s by over 3s`];
}

export function createMobileAudioLanding(deps: MobileAudioLandingDeps): AudioLandingPort {
  const transfer = deps.transfer ?? nativeAudioTransfer;
  const readDuration = deps.readDuration ?? ((uri) => LarkMedia.readDurationSeconds(uri));
  const moveAtomic = deps.moveAtomic ?? ((from, to) => LarkFs.moveAtomic(from, to));

  const audioFile = (songId: string): File => new File(songDirectory(songId), CANONICAL_AUDIO_FILE);

  return {
    hasAudio(songId: string): boolean {
      // The canonical file, not the directory: a cancelled download leaves an
      // empty directory, and that is not a song with a file.
      return audioFile(songId).exists;
    },

    discardUncommitted(songId: string): void {
      // Executes; it does not decide. Whether this directory is the engine's to
      // remove is a database question the engine already answered.
      const directory = songDirectory(songId);
      if (directory.exists) directory.delete();
    },

    async land(input: AudioLandingInput): Promise<{ warnings: string[] }> {
      // ② Before any bytes move (§1.7): this device stores the fMP4 as it
      // arrives and has no encoder, so a non-AAC stream is refused, not
      // transcoded. The desktop's half of D17 is a transcode; this is the other.
      if (!input.expect.isAac) throw new AudioNotAacError();

      const directory = songDirectory(input.songId);
      // ① A brand-new song has no directory yet; a replace already has one.
      if (!directory.exists) directory.create({ intermediates: true });

      const tmp = new File(directory, downloadTmpName(input.taskId));
      /**
       * Undo everything up to ⑤, best-effort.
       *
       * `new` takes the directory too: nothing else of that song's is in there,
       * and a directory with no row and no audio is what the boot sweep would
       * otherwise have to reason about. A `replace` keeps its directory — the
       * old file, the lyrics and the row are all still true.
       */
      const discard = (): void => {
        if (tmp.exists) tmp.delete();
        if (input.mode === 'new' && directory.exists) directory.delete();
      };
      // The client's whole-transfer deadline composed with the task's own
      // cancellation — the host owns the composition, the number stays the
      // client's (§2.2).
      const signal = withTimeout(input.request.timeoutMs, input.signal);

      // ③ Native download into the tmp file.
      input.reportStage('downloading');
      input.onProgress(0, null);
      /** What the source said the whole transfer would be, if it said. */
      let promised: number | null = null;
      try {
        await transfer({
          request: input.request,
          destinationUri: tmp.uri,
          onProgress: (received, total) => {
            if (total !== null) promised = total;
            input.onProgress(received, total);
          },
          signal,
        });
      } catch (err) {
        // Android may leave a partial file behind; leave nothing.
        discard();
        // An abort — the transfer deadline OR a user cancel — propagates
        // UNCHANGED: the engine reads `cancelRequested` to tell them apart, and
        // wrapping it as a BilibiliApiError would report a cancel as a failure
        // (§2.2). Anything else is the normalisation `openAudio` gives the
        // desktop for free: a non-2xx or a dropped connection becomes a
        // BilibiliApiError.
        if (signal.aborted || isAbortError(err)) throw err;
        throw new BilibiliApiError(`audio stream failed: ${reasonOf(err)}`);
      }

      // ③b Did all of it arrive? Only the source can say, and only when it said
      // — a chunked response reports no total, and `null` here is "unknown",
      // never "zero". A short file is a stream that ended early, which is a
      // transport failure and reads as one.
      const landed = tmp.size;
      if (promised !== null && landed < promised) {
        discard();
        throw new BilibiliApiError(`audio stream ended early: ${landed} of ${promised} bytes`);
      }

      // ④ The landed file's real duration (§1.4). Unreadable is what an EMPTY
      // or corrupt transfer looks like — not what a truncated one looks like,
      // which is ③b's job.
      let duration: number;
      try {
        duration = await readDuration(tmp.uri);
      } catch (err) {
        discard();
        throw err;
      }

      const warnings = quotedDurationWarnings(duration, input.expect.expectedDurationSeconds);

      // ⑤ The point of no return. The row and its fresh access land in ONE
      // transaction; `touchLastAccessed` cannot be skipped, or the LRU sorts a
      // just-downloaded song to the front of the eviction queue (§2.3, M5-7).
      input.reportStage('saving');
      try {
        deps.store.sqlite
          .transaction(() => {
            input.commit({ duration });
            touchLastAccessed(deps.store.drizzle, deps.store.sqlite, input.songId);
          })
          .immediate();
      } catch (err) {
        // A landing that half-succeeded would be worse than one that failed, so
        // this undoes itself and says which of the two happened. Same class the
        // desktop raises, because a task that failed here failed the same way
        // whichever host it was on.
        discard();
        throw new DownloadCommitError(
          `could not commit the download of song ${input.songId}; nothing was changed`,
          { cause: err },
        );
      }

      await deps.crashPoint?.();

      // ⑥ Atomic replace. A failure here is a warning, not a lost commit: the
      // row is already the truth, and the next redownload puts the file right.
      try {
        await moveAtomic(tmp.uri, audioFile(input.songId).uri);
      } catch (err) {
        if (tmp.exists) tmp.delete();
        warnings.push(`could not put the audio in place: ${reasonOf(err)}`);
      }

      return { warnings };
    },
  };
}
