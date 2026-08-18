// Getting a song's audio onto this device's storage (N1a, subplan §2.3 v4).
//
// The one port whose shape is an argument rather than a translation, because
// the two hosts do genuinely different things: the desktop streams to a temp
// file, transcodes with ffmpeg, and lands it through a six-step protocol with
// a `.pending` manifest that survives kill -9 (M3-7); the phone will store
// bilibili's fMP4 as it arrives (D17, frozen in N0b-4b — no remux) and clean
// up on the next launch.
//
// What is NOT negotiable is the commit protocol, and it is expressed here so
// that no implementation has to be trusted to remember it:
//
//   `commit` is called exactly once, inside the implementation's own
//   transaction, at its point of no return. Throwing from it rolls the whole
//   landing back; returning from it means the song is committed and can no
//   longer be un-succeeded.
//
//   The actual duration travels through `commit`, not through the return
//   value. It is what gets written to the row, and a second channel for it
//   would be a second answer to "how long is this song".
//
// The three lifecycle calls (`hasAudio`, `discardUncommitted`, `land`) are not
// folded into the generic FileSystem port on purpose: they carry the audio
// directory's protocol and its recovery semantics, which a byte-level
// interface cannot express.

import type { DownloadStage } from '@lark/shared';

export interface AudioStreamExpectation {
  /** The selected DASH stream's codecs string; missing reads as non-AAC. */
  codecs: string;
  isAac: boolean;
  /**
   * Upstream's claim about length, in seconds (the selected page's duration).
   * A REFERENCE for validation only — the row is written from what actually
   * landed, never from what the server promised.
   */
  expectedDurationSeconds: number;
}

export interface LandedAudio {
  /**
   * Verified length of the file that landed, in seconds. Desktop: ffprobe of
   * the output. However a mobile implementation obtains it, it may not drop
   * off this interface — this is the number the library row carries.
   */
  duration: number;
}

export interface AudioLandingInput {
  taskId: string;
  songId: string;
  mode: 'new' | 'replace';
  /** Open the authenticated audio stream; headers, cookies and timeouts stay in the client. */
  openStream(signal: AbortSignal): Promise<Response>;
  expect: AudioStreamExpectation;
  /** downloading → converting → saving; the event order is part of the contract. */
  reportStage(stage: DownloadStage): void;
  onProgress(received: number, totalBytes: number | null): void;
  /** See the commit protocol above: exactly once, in-transaction, at the point of no return. */
  commit(result: LandedAudio): void;
  signal: AbortSignal;
}

export interface AudioLandingPort {
  /** Does this song's audio exist? Short-circuits `ensure-file` and decides `needsFile`. */
  hasAudio(songId: string): boolean;

  /**
   * Remove a song directory that was never committed.
   *
   * The JUDGEMENT — "there is no row for this song, so the directory is
   * mine to delete" — stays in the portable engine, which is the only place
   * that can re-read the database. This call only executes the removal, which
   * is what keeps "a failed redownload must never delete existing audio" a
   * property of one decision instead of two.
   */
  discardUncommitted(songId: string): void;

  /** Warnings worth surfacing; the result itself travels through `commit`. */
  land(input: AudioLandingInput): Promise<{ warnings: string[] }>;
}
