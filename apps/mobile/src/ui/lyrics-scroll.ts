// Where the lyric list has to sit for the playing line to be in the middle
// (⑥).
//
// 🔴 WHY THE LAST LINE USED TO STOP. The list scrolled to `top - height / 3`
// and the content had 12px of padding under it, so there was nothing below the
// last line to scroll INTO: the bottom two thirds of the screen could never
// hold the current line, and every line in it looked stuck. The fix is not a
// bigger scroll — a `ScrollView` clamps at the end of its content — it is
// content that reaches half a screen past the last line.
//
// Positions come from `onLayout` rather than `index * lineHeight`, because a
// long line wraps and a computed offset drifts further from the truth with
// every wrapped line above it. What is computed here is only the arithmetic
// between a measured `y` and a scroll offset.

/** Every lyric row is this tall; a wrapped one is a multiple of it. */
export const LYRIC_LINE_HEIGHT = 30;

export interface LyricsPadding {
  readonly paddingTop: number;
  readonly paddingBottom: number;
}

/**
 * Half a screen above the first line and half a screen below the last, which
 * is what makes the middle reachable by every line rather than only by the
 * ones with enough neighbours underneath them.
 *
 * Half a LINE is taken off each side so the two ends line up exactly: the
 * first line is centred at scroll 0 and the last one at the end of the scroll
 * range, with no dead travel at either end.
 */
export function lyricsPadding(viewportHeight: number, lineHeight: number): LyricsPadding {
  const half = Math.max(0, (viewportHeight - lineHeight) / 2);
  return { paddingTop: half, paddingBottom: half };
}

/**
 * Where to scroll so line `index` is centred, or `null` for "do not scroll".
 *
 * `null` rather than 0 is the whole answer to a song change: the measurements
 * belong to the song that produced them, and a missing one means the new lines
 * have not been laid out yet. Scrolling to 0 would be a decision; this is the
 * absence of one.
 */
export function targetOffset({
  tops,
  index,
  viewportHeight,
  lineHeight,
}: {
  readonly tops: readonly number[];
  readonly index: number;
  readonly viewportHeight: number;
  readonly lineHeight: number;
}): number | null {
  const top = tops[index];
  if (top === undefined || viewportHeight <= 0) return null;
  return Math.max(0, top + lineHeight / 2 - viewportHeight / 2);
}

/**
 * Which line the middle of the screen is currently on (⑦).
 *
 * The other direction from `targetOffset`: that one is told a line and asked
 * for an offset, this one is told an offset and asked for a line. It is what
 * the indicator names while a finger is dragging the list, and therefore what
 * a tap on it seeks to.
 *
 * `null` only for a list with nothing measured in it — anything else lands on
 * a line, because the padding makes every position reachable.
 */
export function lineAtCentre(
  tops: readonly number[],
  scrollY: number,
  viewportHeight: number,
): number | null {
  if (viewportHeight <= 0) return null;
  const centre = scrollY + viewportHeight / 2;
  let found: number | null = null;
  for (const [i, top] of tops.entries()) {
    // A line that has not been laid out yet is skipped rather than treated as
    // the end: `onLayout` fills the array one entry at a time.
    if (top === undefined || top > centre) continue;
    found = i;
  }
  // Above the first measured line — only reachable with a bounce at the top,
  // and the answer there is the first line, not "no line".
  if (found === null && tops.some((top) => top !== undefined)) return 0;
  return found;
}

/**
 * How long after a drag the list waits before following the song again (⑦).
 *
 * The industry number: long enough to read the line you scrolled to, short
 * enough that nobody wonders whether it is broken.
 */
export const FOLLOW_RESUME_MS = 3000;

/**
 * Whether the list is following the song or the finger.
 *
 * `settling` is the gap between them: the finger is off the glass but the eye
 * is still on the line it left, and yanking the list back at that moment is
 * the thing every player learned not to do.
 */
export type FollowState =
  | { readonly kind: 'follow' }
  | { readonly kind: 'dragging' }
  | { readonly kind: 'settling'; readonly until: number };

export const FOLLOWING: FollowState = { kind: 'follow' };

/** A finger went down on the list. */
export function onDragBegin(): FollowState {
  return { kind: 'dragging' };
}

/**
 * The list stopped moving.
 *
 * 🔴 A LIST THAT IS FOLLOWING NEVER SETTLES. An animated `scrollTo` ends in a
 * momentum event too, so a machine that took every one of them would drop into
 * `settling` every time the song moved to the next line — putting the seek
 * indicator on screen for three seconds at a time, with nobody having touched
 * anything.
 *
 * Every other state does, including `settling` itself: a flick fires the end
 * of the DRAG when the finger lifts and the end of the MOMENTUM when the list
 * finally stops, and the wait is meant to start from the second one.
 */
export function onScrollSettled(state: FollowState, now: number): FollowState {
  if (state.kind === 'follow') return state;
  return { kind: 'settling', until: now + FOLLOW_RESUME_MS };
}

/** Time passing is the only thing that ends `settling` on its own. */
export function onTick(state: FollowState, now: number): FollowState {
  if (state.kind !== 'settling' || now < state.until) return state;
  return FOLLOWING;
}

/**
 * Somebody tapped the indicator and the song jumped there.
 *
 * Straight back to following, not a restarted countdown: the line they picked
 * is the line that is playing now, so there is nothing left to hold the list
 * away from it.
 */
export function onSeek(): FollowState {
  return FOLLOWING;
}

/** The list follows the song; otherwise the finger has it. */
export function isFollowing(state: FollowState): boolean {
  return state.kind === 'follow';
}
