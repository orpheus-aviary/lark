// What plays next — the four Go-parity rules, in one place (N3b, decision a).
//
// A DECISION, NOT AN ACTION. The desktop's version of this called `ops.play`
// and read a zustand store, which is why "share the five functions" was not
// something that could be done until they had a return type: the host plays,
// shows a message, or stops, and this decides which. That split is also what
// settles a contradiction the plan carried — the matrix said a refusal was
// silent, and decision n said a refusal a user asked for must speak. Both are
// right, because "there is nothing to play" and "tell them so" are not the
// same decision.
//
// The four rules each cost somebody something before they were written down:
//
//   1. `sequential` ENDS at the end of the list. Only `repeat-all` wraps —
//      and only when a song finished. A user pressing "next" on the last song
//      wraps in every mode, because pressing a button is an intent and a song
//      running out is not.
//   2. `shuffle` picks another song, never this one again — from the ones with
//      a file when a song ran out, from all of them when a button was pressed
//      (rule 3 decides which).
//   3. A neighbour with no file is NOT a wall — and which way it gives depends
//      on whether a finger is on the button (N4g-3, decision i). A button
//      press is a play intent, exactly like tapping the row: the host fetches
//      the file and plays it when it lands. A song that simply ran out has
//      nobody's finger on it, so it may not spend anyone's data: the sequence
//      SKIPS to the next song that has a file.
//
//      🔴 SINCE 0.1.1 THAT LAST HALF IS A SETTING, and `fetchWhenEnded` is it.
//      Turned on — which is the default on both hosts — a song that ran out
//      may name a neighbour with no file, and the host fetches it exactly as
//      it would for a button. The setting exists because "may not spend
//      anyone's data" was decided for a phone on mobile data, and most of the
//      time somebody listening to a list wants the list to keep playing.
//      It is a REQUIRED input rather than an option with a default: the two
//      hosts must not be able to disagree by one of them forgetting to pass
//      it, which is precisely how a rule ends up meaning two things.
//
//      Until N4g this rule was "stop, never skip", inherited from Go: skipping
//      was said to turn "this song is missing" into "this song does not
//      exist". What changed is that both hosts can now GET the file back, and
//      a list still says which of its rows need downloading — so the fact is
//      not hidden by skipping, while stopping dead in the middle of a queue
//      (or refusing a button that a row tap would have honoured) reads as
//      broken. MEASURED, 2026-08-24, on the frozen device.
//   4. When the current song is not in the queue at all — the desktop's D11,
//      after switching lists — advancing goes nowhere rather than jumping to a
//      position that means nothing.
//
// `repeat-one` answers before any of them: a song that finished under it
// restarts, whether or not it is in the queue.

import { PLAY_MODES, type PlayMode, type SongData } from './types.js';

/** What made us ask. A button press and a song running out differ (rule 1). */
export type QueueTrigger = 'ended' | 'next' | 'prev';

export type QueueDecision =
  | { kind: 'play'; songId: string }
  | { kind: 'restart' }
  | { kind: 'stop'; reason: 'end-of-list' | 'no-playable' | 'not-in-queue' }
  | { kind: 'reject'; reason: 'not-in-queue' | 'no-other-playable' };

export interface QueueDecisionInput {
  /** The queue, in play order. */
  songs: readonly SongData[];
  currentId: string | null;
  mode: PlayMode;
  trigger: QueueTrigger;
  /**
   * May a song that ran out name a neighbour with no file? See rule 3.
   *
   * Required, and both hosts read it from a setting the person owns.
   */
  fetchWhenEnded: boolean;
  /** Injected so `shuffle` is decidable in a test. Defaults to `Math.random`. */
  random?: () => number;
}

/**
 * The cycle the mode button walks, which is NOT `PLAY_MODES`.
 *
 * `PLAY_MODES` is the wire order and lists `repeat-one` second; iterating that
 * as a UI cycle would quietly reorder the button (M4-10). Both front ends walk
 * this one.
 */
export const UI_PLAY_MODE_CYCLE = [
  'sequential',
  'repeat-all',
  'repeat-one',
  'shuffle',
] as const satisfies readonly PlayMode[];

export const PLAY_MODE_LABELS: Record<PlayMode, string> = {
  sequential: '顺序播放',
  'repeat-all': '列表循环',
  'repeat-one': '单曲循环',
  shuffle: '随机播放',
};

export function isPlayMode(value: unknown): value is PlayMode {
  return PLAY_MODES.some((mode) => mode === value);
}

export function nextPlayMode(mode: PlayMode): PlayMode {
  const index = UI_PLAY_MODE_CYCLE.indexOf(mode);
  return UI_PLAY_MODE_CYCLE[(index + 1) % UI_PLAY_MODE_CYCLE.length] as PlayMode;
}

/** `has_file` is optional; only an explicit `false` means "not here" (M5-9). */
const playable = (song: SongData): boolean => song.has_file !== false;

export function decideNext(input: QueueDecisionInput): QueueDecision {
  const { songs, currentId, mode, trigger, fetchWhenEnded, random = Math.random } = input;

  // Before everything else, including "is it even in the queue": under
  // repeat-one a finished song restarts, full stop.
  if (mode === 'repeat-one' && trigger === 'ended') return { kind: 'restart' };

  const index = currentId === null ? -1 : songs.findIndex((song) => song.id === currentId);
  if (index < 0 || songs.length === 0) {
    // Rule 4, and the two triggers part company here: a song that ended with
    // nowhere to go just stops, while a button that went nowhere owes the
    // person who pressed it an answer.
    return trigger === 'ended'
      ? { kind: 'stop', reason: 'not-in-queue' }
      : { kind: 'reject', reason: 'not-in-queue' };
  }

  if (mode === 'shuffle' && trigger !== 'prev') {
    // Rule 2. `prev` is deliberately not random: "back" means the one before.
    //
    // The pool follows rule 3's split: a pressed button may land on a song
    // with no file (the host fetches it), a song that ran out may not. Without
    // that, shuffle would refuse on a library whose files have been evicted
    // while sequential happily fetched — the same inconsistency rule 3 exists
    // to remove.
    const pool = songs.filter(
      (song, i) => i !== index && (trigger === 'next' || fetchWhenEnded || playable(song)),
    );
    const pick = pool[Math.floor(random() * pool.length)];
    if (pick === undefined) {
      return trigger === 'ended'
        ? { kind: 'stop', reason: 'no-playable' }
        : { kind: 'reject', reason: 'no-other-playable' };
    }
    return { kind: 'play', songId: pick.id };
  }

  if (mode === 'sequential' && trigger === 'ended' && index >= songs.length - 1) {
    return { kind: 'stop', reason: 'end-of-list' }; // rule 1
  }

  if (trigger === 'ended') {
    // Rule 3, the no-finger half: walk forward to the next song that has a
    // file. `sequential` may not wrap (rule 1), so it stops at the end of the
    // list; `repeat-all` goes all the way round, and the last candidate it
    // considers is the current song itself — which is what a list loop with
    // one playable song in it means.
    const reach = mode === 'sequential' ? songs.length - 1 - index : songs.length;
    for (let ahead = 1; ahead <= reach; ahead += 1) {
      const candidate = songs[(index + ahead) % songs.length] as SongData;
      // With the setting on, the FIRST neighbour wins whether or not its file
      // is here — which is what makes a list play in the order it is written
      // rather than in the order it happens to have been downloaded.
      if (fetchWhenEnded || playable(candidate)) return { kind: 'play', songId: candidate.id };
    }
    return { kind: 'stop', reason: 'no-playable' };
  }

  // Rule 3, the finger half: whatever is next, file or no file. A host that
  // gets back a song with `has_file === false` fetches it and plays it when it
  // lands — the same path a tap on the row takes.
  const step = trigger === 'prev' ? -1 : 1;
  const target = songs[(index + step + songs.length) % songs.length] as SongData;
  return { kind: 'play', songId: target.id };
}
