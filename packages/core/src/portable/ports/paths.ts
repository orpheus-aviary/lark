// Where a song's files are, as SEMANTICS rather than string surgery (N1a).
//
// Portable code names things — "this song's audio" — and never joins a path.
// That is not stylistic: `songs/<id>/` is a real filesystem location built
// from an id that arrived over the wire, so every path in the library has to
// pass the UUID gate first (R10), and a phone's storage is not addressed the
// way a Mac's home directory is. A business module that could concatenate
// would eventually concatenate somewhere the gate is not.
//
// `join` therefore stays inside the adapters. It is not on this interface and
// it is not in the portable half of core at all.

import { isUuidV4 } from '@lark/shared';
import { InvalidIdError } from '../errors.js';

/**
 * The gate every implementation owes its callers, shared so that no host
 * re-derives it. R10: an id that has not passed this must not reach a path.
 */
export function assertSongId(id: string): void {
  if (!isUuidV4(id)) throw new InvalidIdError(id);
}

/**
 * The one audio file name in the library (0.3.0). Everything writes it and
 * everything reads it; there is no probing and no second format.
 *
 * A file NAME is not a path — it is the same string on every host, and portable
 * code that decides "is this song's audio present" (`sync/file-ops`) has to be
 * able to say it without reaching for the desktop's `paths.ts`. Joining it to a
 * directory still belongs to the adapters.
 */
export const CANONICAL_AUDIO_FILE = 'song.m4a';

/**
 * What 0.2.x wrote. Only two kinds of code may mention it: the one-time
 * migration, and the `has_file` probe while that migration is still pending
 * (a song not converted yet is present, and reporting it as missing would
 * offer the user a download for a file they already have).
 */
export const LEGACY_AUDIO_FILE = 'song.mp3';

export interface PathsPort {
  /** `songs/<id>/` — the song's own directory. */
  songDir(id: string): string;
  /** The one audio file (0.3.0: `song.m4a`). */
  songAudio(id: string): string;
  /**
   * What 0.2.x wrote (`song.mp3`).
   *
   * Only two callers may name it: the one-time migration, and the `has_file`
   * probe while that migration is still pending — a song waiting its turn is
   * present, and reporting it as missing would offer a download for a file the
   * user already has.
   */
  songLegacyAudio(id: string): string;
  /** `lyrics.lrc`, beside the audio but never treated as audio (R1/R26). */
  songLyrics(id: string): string;
}
