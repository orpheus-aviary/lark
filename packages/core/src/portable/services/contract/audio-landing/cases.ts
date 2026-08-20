// The eight cases every host that lands audio owes (N4a, judgement 3).
//
// Pure and host-free: no test runner, no Node, no file system. Everything a
// case needs it asks the subject for, so the same assertions run against the
// desktop's ffmpeg landing and the phone's native one.
//
// Five of them (the commit protocol and the two lifecycle answers) were the
// desktop's own `audio-landing.test.ts` before N4; the three transfer cases
// are new, and pin the error normalisation the port now spells out (§2.2).

import { check, equal } from '../../../contract/assert.js';
import type { AudioLandingContractCase } from './types.js';

export const AUDIO_LANDING_CONTRACT_CASES: readonly AudioLandingContractCase[] = [
  // ── the commit protocol ──
  {
    group: 'commit',
    name: 'commit runs exactly once and is handed the landed duration',
    async run(s) {
      const id = s.newSongId();
      const report = await s.land({ scenario: 'valid', songId: id, mode: 'new' });
      equal(report.outcome, 'landed', 'the landing succeeded');
      equal(report.commitCalls, 1, 'commit ran exactly once');
      check((report.committedDuration ?? 0) > 0, 'a real duration was committed');
      check(s.hasAudio(id), 'the canonical file is there afterwards');
    },
  },
  {
    group: 'commit',
    name: 'a thrown commit rolls the landing back and restores the old file',
    async run(s) {
      const id = s.newSongId();
      s.placeExistingAudio(id, 'OLD');
      const report = await s.land({
        scenario: 'valid',
        songId: id,
        mode: 'replace',
        commitThrows: true,
      });
      equal(report.outcome, 'commit-threw', 'the landing rolled back');
      equal(report.commitCalls, 1, 'commit was attempted once');
      // The point of the protocol: the file that was there is the file that is
      // there. A landing that half-succeeded would be worse than one that failed.
      equal(s.readAudio(id), 'OLD', 'the old file is intact');
      equal(s.residue(id).length, 0, 'nothing of the attempt is left behind');
    },
  },
  {
    group: 'commit',
    name: 'a new song that fails to commit leaves nothing behind',
    async run(s) {
      const id = s.newSongId();
      const report = await s.land({
        scenario: 'valid',
        songId: id,
        mode: 'new',
        commitThrows: true,
      });
      equal(report.outcome, 'commit-threw', 'the landing rolled back');
      // A brand-new song owns nothing else in that directory, so the whole
      // thing goes — leaving it would look like an orphan to recovery.
      check(!s.dirExists(id), 'the whole directory is gone');
    },
  },

  // ── the two lifecycle answers ──
  {
    group: 'lifecycle',
    name: 'hasAudio reports the canonical file, not the directory',
    async run(s) {
      const id = s.newSongId();
      check(!s.hasAudio(id), 'nothing there yet');
      // A directory with no audio in it is not a song with a file — that is
      // the state a cancelled download leaves behind.
      s.makeEmptyDir(id);
      check(s.dirExists(id), 'the directory exists');
      check(!s.hasAudio(id), 'but there is no canonical file in it');
      s.placeExistingAudio(id, 'x');
      check(s.hasAudio(id), 'now the file is there');
    },
  },
  {
    group: 'lifecycle',
    name: 'discardUncommitted removes the directory and is quiet about a missing one',
    async run(s) {
      const id = s.newSongId();
      s.placeExistingAudio(id, 'x');
      s.discardUncommitted(id);
      check(!s.dirExists(id), 'the directory is gone');
      // Idempotent: boot recovery and a cancelled task can both reach it.
      s.discardUncommitted(id);
    },
  },

  // ── error normalisation, one row of §2.2's table each ──
  {
    group: 'transfer',
    name: 'a non-2xx response becomes a BilibiliApiError',
    async run(s) {
      const id = s.newSongId();
      const report = await s.land({ scenario: 'http-error', songId: id, mode: 'new' });
      equal(report.outcome, 'api-error', 'the transfer normalised the status');
      equal(report.commitCalls, 0, 'nothing was committed');
    },
  },
  {
    group: 'transfer',
    name: 'a transfer that outlives its deadline aborts (the task fails)',
    async run(s) {
      const id = s.newSongId();
      const report = await s.land({ scenario: 'timeout', songId: id, mode: 'new' });
      equal(report.outcome, 'timed-out', 'the deadline ended it, not the caller');
      equal(report.commitCalls, 0, 'nothing was committed');
    },
  },
  {
    group: 'transfer',
    name: 'a caller cancel propagates unchanged (the task is cancelled, not failed)',
    async run(s) {
      const id = s.newSongId();
      const report = await s.land({ scenario: 'cancel', songId: id, mode: 'new' });
      // Unchanged: not swallowed, not turned into a BilibiliApiError — the
      // engine reads the abort as a cancel, and a `failed` here would be wrong.
      equal(report.outcome, 'cancelled', 'the abort propagated as a cancel');
      equal(report.commitCalls, 0, 'nothing was committed');
    },
  },
];
