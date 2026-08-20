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
   * Upstream's claim about length, in seconds (the selected page's duration),
   * or `null` when nothing upstream said.
   *
   * A REFERENCE for validation only — the row is written from what actually
   * landed, never from what the server promised, and the desktop deliberately
   * ignores it: it probes the bytes that arrived, because a stream that
   * announces `mp4a.40.2` and delivers something else would otherwise be
   * copied into a canonical file that cannot be played.
   *
   * Filled from N4: both a new song (`resolveTarget`) and a redownload
   * (`probeSourceKey`) resolve a full `NormalizedSource`, so both have a page
   * duration to quote. Still nullable — an upstream that omits it is not a
   * failure, because nothing here trusts the number. The cross-host signature
   * is frozen at N4 (§2.2).
   */
  expectedDurationSeconds: number | null;
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
  /**
   * Open the authenticated audio stream; headers, cookies and timeouts stay in
   * the client. For a host that reads the body in JS (desktop).
   */
  openStream(signal: AbortSignal): Promise<Response>;
  /**
   * The SAME request as `openStream`, described rather than opened, for a host
   * that downloads natively (the phone, N4). `timeoutMs` is the whole
   * transfer's deadline, from the client — the host composes it with `signal`
   * rather than inventing one. Two descriptions of one request; a host uses
   * exactly one.
   *
   * A native transfer OWES the same error normalisation `openStream` gets for
   * free from the client (§2.2), and the AudioLandingContract holds every host
   * to it:
   *
   *   - HTTP non-2xx  → `BilibiliApiError` (message carries the status)
   *   - transfer deadline → an abort (the task settles `failed`)
   *   - the caller aborts `signal` → the abort propagates unchanged (the task
   *     settles `cancelled`, not `failed`, and never a `BilibiliApiError`)
   */
  request: { url: string; headers: Readonly<Record<string, string>>; timeoutMs: number };
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
