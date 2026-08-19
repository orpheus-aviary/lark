// The desktop's `AudioLandingPort` (N1h, subplan §2.3).
//
// Everything between "open the stream" and "the row is committed" on a Mac:
// stream to a temp file inside the song's own directory, transcode with
// ffmpeg, probe what came out, and land it through the six-step protocol with
// its `.pending` manifest (M3-7). None of that moved — `fetchAudio`'s body and
// `landSongFile` are the same code they were, in the same order — what changed
// is that the engine no longer knows any of it.
//
// The engine keeps the two things that are NOT storage: which stream to open
// (the client's job) and what to write in the row (the library's). That is the
// whole point of the cut: a phone stores bilibili's fMP4 as it arrives (D17)
// and needs no ffmpeg, but it commits the same row at the same moment.
//
// Same-volume staging is deliberate and survives here: the Go version wrote to
// the system temp directory and renamed across devices, which fails on any
// setup where the nest is not on the root filesystem.

import { createWriteStream, existsSync, rmSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { BilibiliApiError } from '../errors.js';
import type { MediaToolsProvider } from '../media-tools/registry.js';
import { songAudioPath, songDirPath } from '../paths.js';
import type { PortableDb } from '../portable/db.js';
import type { DownloadTimeouts } from '../portable/download/timeouts.js';
import type { AudioLandingInput, AudioLandingPort } from '../portable/ports/audio-landing.js';
import { probeAudio, processAudio } from './ffmpeg.js';
import { landSongFile, stagePaths } from './resolve.js';

export interface NodeAudioLandingDeps {
  store: PortableDb;
  mediaTools: MediaToolsProvider;
  timeouts: DownloadTimeouts;
}

export function nodeAudioLanding(deps: NodeAudioLandingDeps): AudioLandingPort {
  return {
    hasAudio(songId: string): boolean {
      return existsSync(songAudioPath(songId));
    },

    discardUncommitted(songId: string): void {
      // Executes; it does not decide. Whether this directory is the engine's
      // to remove is a database question, and the engine is the only side that
      // can ask it — which is what keeps "a failed redownload must never
      // delete existing audio" one decision instead of two.
      rmSync(songDirPath(songId), { recursive: true, force: true });
    },

    async land(input: AudioLandingInput): Promise<{ warnings: string[] }> {
      const paths = stagePaths(input.songId, input.taskId);
      // Before any bytes move: the transfer exists only to be transcoded, so a
      // machine with no usable ffmpeg fails here rather than after it has
      // pulled down the whole track (M7-18).
      await deps.mediaTools.acquire();
      // A brand-new song has no directory yet, and staging happens INSIDE it
      // (the whole point of same-volume staging), so it has to exist first.
      await mkdir(paths.dir, { recursive: true });

      input.reportStage('downloading');
      const response = await input.openStream(input.signal);
      if (response.body === null) {
        throw new BilibiliApiError(`the audio stream for song ${input.songId} had no body`);
      }
      // `null` rather than 0 when the source does not say: "unknown size" and
      // "empty" ask a progress line for different things (§3.5).
      const declared = Number(response.headers.get('content-length'));
      const total = Number.isFinite(declared) && declared > 0 ? declared : null;
      input.onProgress(0, total);

      await streamPipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        countingStream(input, total),
        createWriteStream(paths.download),
        { signal: input.signal },
      );

      input.reportStage('converting');
      const landed = await deps.mediaTools.use(async (tools) => {
        const run = { signal: input.signal, timeouts: deps.timeouts };
        try {
          // Probe the bytes that arrived, and let THAT decide the conversion.
          // The caller already preferred an AAC candidate so this is normally
          // a rewrap — the audio the user hears is the audio bilibili sent —
          // but the decision is never taken from `input.expect`: a stream that
          // says `mp4a.40.2` and delivers something else would otherwise be
          // copied into a canonical file that cannot be played.
          const source = await probeAudio(tools.ffprobe.path, paths.download, run);
          await processAudio(tools.ffmpeg.path, paths.download, paths.transcoded, source, run);
        } finally {
          // The raw download is dead weight either way, and leaving it behind
          // would make the next startup recovery report residue that is not.
          await unlink(paths.download).catch(() => {});
        }
        // Probe the OUTPUT for the duration that goes in the row: a copy that
        // silently carried no audio would otherwise be committed as a song.
        return probeAudio(tools.ffprobe.path, paths.transcoded, run);
      });

      // Reported HERE, by the implementation, because it marks the moment the
      // landing becomes uncancellable — and the engine, which used to set it,
      // cannot see that moment from outside any more. It is also what freezes
      // the target list, so `commit` reads that list after this line.
      input.reportStage('saving');

      return landSongFile(deps.store.drizzle, deps.store.sqlite, {
        taskId: input.taskId,
        songId: input.songId,
        stagedPath: paths.transcoded,
        mode: input.mode,
        // Exactly once, inside `landSongFile`'s transaction, at its point of no
        // return — the protocol the port declares, satisfied by the same call
        // this always was. The duration travels with it because the row is
        // written from what landed, never from what upstream promised.
        commit: () => {
          input.commit({ duration: landed.duration });
        },
      });
    },
  };
}

/**
 * A pass-through that counts. Chunk-level rather than a `data` listener on the
 * source: inside the pipeline it inherits the backpressure and the abort
 * handling that `streamPipeline` already gives every other member, and a task
 * cancelled mid-transfer tears down the whole chain rather than leaking a
 * listener on a stream nobody is reading.
 */
function countingStream(input: AudioLandingInput, total: number | null): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      input.onProgress(received, total);
      callback(null, chunk);
    },
  });
}
