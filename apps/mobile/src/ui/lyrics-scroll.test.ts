import { describe, expect, it } from 'vitest';
import { LYRIC_LINE_HEIGHT, lyricsPadding, targetOffset } from './lyrics-scroll';

const VIEWPORT = 600;
const LINE = LYRIC_LINE_HEIGHT;

/** The y `onLayout` reports for each line: the padding, then one row each. */
function tops(count: number): number[] {
  const { paddingTop } = lyricsPadding(VIEWPORT, LINE);
  return Array.from({ length: count }, (_, i) => paddingTop + i * LINE);
}

/** As far as a ScrollView will go — past this it clamps, silently. */
function maxScroll(count: number): number {
  const { paddingTop, paddingBottom } = lyricsPadding(VIEWPORT, LINE);
  return paddingTop + count * LINE + paddingBottom - VIEWPORT;
}

/** Where the centre of line `index` ends up once scrolled to `scroll`. */
function centreOnScreen(count: number, index: number, scroll: number): number {
  return tops(count)[index]! - scroll + LINE / 2;
}

const at = (count: number, index: number): number | null =>
  targetOffset({ tops: tops(count), index, viewportHeight: VIEWPORT, lineHeight: LINE });

describe('scrolling the lyrics', () => {
  it('puts a line in the middle of the screen', () => {
    const scroll = at(40, 20);
    expect(scroll).not.toBeNull();
    expect(centreOnScreen(40, 20, scroll ?? 0)).toBe(VIEWPORT / 2);
  });

  // ⑥ itself: the last line could not reach the middle, because the content
  // ended right under it and the ScrollView clamped there.
  it('lets the LAST line reach the middle, and stays inside the content', () => {
    const scroll = at(40, 39);
    expect(scroll).not.toBeNull();
    expect(centreOnScreen(40, 39, scroll ?? 0)).toBe(VIEWPORT / 2);
    expect(scroll ?? 0).toBeLessThanOrEqual(maxScroll(40));
  });

  it('lets the first line reach it too, with no travel to spare', () => {
    expect(at(40, 0)).toBe(0);
    expect(centreOnScreen(40, 0, 0)).toBe(VIEWPORT / 2);
  });

  // A song change: `index` has already moved to the new lyrics while the ref
  // still holds nothing for them. Scrolling to 0 would be a decision.
  it('does not scroll while the new lines are unmeasured', () => {
    expect(targetOffset({ tops: [], index: 3, viewportHeight: VIEWPORT, lineHeight: LINE })).toBe(
      null,
    );
  });

  it('does not scroll before the viewport has a height', () => {
    expect(targetOffset({ tops: tops(4), index: 1, viewportHeight: 0, lineHeight: LINE })).toBe(
      null,
    );
  });

  it('has nothing to scroll to when nothing is playing', () => {
    expect(at(40, -1)).toBe(null);
  });
});
