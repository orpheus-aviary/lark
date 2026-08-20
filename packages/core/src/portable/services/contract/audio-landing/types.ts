// The AudioLandingContract's vocabulary (N4a, subplan §2.4 / judgement 3).
//
// One suite of cases, run against every host that implements `AudioLandingPort`
// — the desktop's ffmpeg landing today, the phone's native one in N4b. The
// point is the same as the LibraryContract's: the two hosts make the SAME
// promises about the commit protocol and the SAME error normalisation, rather
// than two implementations that agree for a while (§2.2).
//
// A case never names a host's error class. It asks the subject to drive a
// landing under a `scenario`, and reads back a normalised `outcome`; the host
// hook is what maps its own exceptions (a `BilibiliApiError`, an `AbortError`,
// a thrown commit) onto that small vocabulary.

/** What the underlying transfer does during one landing. */
export type AudioLandingScenario =
  /** Serves a real, decodable track that lands cleanly. */
  | 'valid'
  /** The audio endpoint answers a non-2xx status. */
  | 'http-error'
  /** The transfer never finishes; its deadline is what ends it. */
  | 'timeout'
  /** The caller aborts the landing's signal mid-transfer. */
  | 'cancel';

/** How a landing ended, as the host classifies it (§2.2). */
export type AudioLandingOutcome =
  /** `land` resolved and `commit` ran. */
  | 'landed'
  /** `commit` threw; the landing rolled back. */
  | 'commit-threw'
  /** A non-2xx status normalised to `BilibiliApiError`. */
  | 'api-error'
  /** The transfer's deadline fired; the abort was not the caller's. */
  | 'timed-out'
  /** The caller's abort propagated unchanged. */
  | 'cancelled'
  /** Anything the host could not place — always a case failure. */
  | 'other';

export interface AudioLandingAttempt {
  scenario: AudioLandingScenario;
  songId: string;
  mode: 'new' | 'replace';
  /** Make `commit` throw, to exercise the rollback. */
  commitThrows?: boolean;
}

export interface AudioLandingReport {
  outcome: AudioLandingOutcome;
  /** How many times `commit` ran — the protocol says at most once. */
  commitCalls: number;
  /** The duration handed to `commit`, when it ran. */
  committedDuration: number | null;
}

/**
 * One host's AudioLandingPort, plus the seams a case needs to set up and
 * inspect the storage around it. Everything is async where a host might be
 * (the phone's file ops cross a native bridge).
 */
export interface AudioLandingSubject {
  /** A fresh song id nothing has landed yet. */
  newSongId(): string;
  /** Drive one landing under `scenario`, and report how it ended. */
  land(attempt: AudioLandingAttempt): Promise<AudioLandingReport>;

  hasAudio(songId: string): boolean;
  discardUncommitted(songId: string): void;

  // ── seams the cases use to build and read the storage ──

  /** Put a committed canonical file in place, carrying a recognisable marker. */
  placeExistingAudio(songId: string, marker: string): void;
  /** Create the song's directory with no audio in it (a cancelled download's residue). */
  makeEmptyDir(songId: string): void;
  /** The canonical file's contents, or null when there is none. */
  readAudio(songId: string): string | null;
  /** Does the song's directory exist on disk? */
  dirExists(songId: string): boolean;
  /** Hidden staging leftovers (dot-prefixed names) in the song's directory. */
  residue(songId: string): string[];
}

export interface AudioLandingContractHooks {
  /** A fresh, empty library + landing reachable through this host. */
  open(): Promise<AudioLandingSubject>;
  /** Release it. Called once per case, including after a failure. */
  close(subject: AudioLandingSubject): Promise<void>;
}

export interface AudioLandingContractCase {
  readonly group: string;
  readonly name: string;
  /** Throws to fail. Gets a subject fresh from the hook. */
  run(subject: AudioLandingSubject): Promise<void>;
}
