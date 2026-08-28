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
