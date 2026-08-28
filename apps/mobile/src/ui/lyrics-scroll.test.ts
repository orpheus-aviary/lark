import { describe, expect, it } from 'vitest';
import {
  FOLLOWING,
  FOLLOW_RESUME_MS,
  type FollowState,
  LYRIC_LINE_HEIGHT,
  isFollowing,
  lineAtCentre,
  lyricsPadding,
  onDragBegin,
  onScrollSettled,
  onSeek,
  onTick,
  targetOffset,
} from './lyrics-scroll';

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

// ⑦ — the other direction: which line is under the middle of the screen.
describe('the line at the centre', () => {
  it('names the line the middle is sitting on', () => {
    // Scrolled to where line 20 is centred, so that is the line it names.
    const scroll = targetOffset({
      tops: tops(40),
      index: 20,
      viewportHeight: VIEWPORT,
      lineHeight: LINE,
    });
    expect(lineAtCentre(tops(40), scroll ?? 0, VIEWPORT)).toBe(20);
  });

  it('agrees with `targetOffset` on every line, which is what makes a tap land', () => {
    const measured = tops(30);
    for (let index = 0; index < measured.length; index++) {
      const scroll = targetOffset({
        tops: measured,
        index,
        viewportHeight: VIEWPORT,
        lineHeight: LINE,
      });
      expect(lineAtCentre(measured, scroll ?? 0, VIEWPORT)).toBe(index);
    }
  });

  it('has no answer for a list nothing has measured', () => {
    expect(lineAtCentre([], 0, VIEWPORT)).toBe(null);
  });
});

// The three states, and the one transition that is a product decision.
describe('following the song, or the finger', () => {
  const settled = (state: FollowState, now: number): FollowState => onScrollSettled(state, now);

  it('follows until a finger goes down', () => {
    expect(isFollowing(FOLLOWING)).toBe(true);
    expect(isFollowing(onDragBegin())).toBe(false);
  });

  it('waits after the drag, then follows again on its own', () => {
    const waiting = settled(onDragBegin(), 1000);
    expect(isFollowing(waiting)).toBe(false);
    expect(isFollowing(onTick(waiting, 1000 + FOLLOW_RESUME_MS - 1))).toBe(false);
    expect(isFollowing(onTick(waiting, 1000 + FOLLOW_RESUME_MS))).toBe(true);
  });

  // An animated `scrollTo` ends in the same event a flick does.
  it('does not start waiting because the song scrolled the list itself', () => {
    expect(settled(FOLLOWING, 1000)).toBe(FOLLOWING);
  });

  // A flick reports twice: the finger lifting, then the list coming to rest.
  it('starts the wait when the list stops, not when the finger lifts', () => {
    const lifted = settled(onDragBegin(), 1000);
    const stopped = settled(lifted, 1800);
    expect(onTick(stopped, 1000 + FOLLOW_RESUME_MS).kind).toBe('settling');
    expect(onTick(stopped, 1800 + FOLLOW_RESUME_MS).kind).toBe('follow');
  });

  it('keeps waiting from the LAST settle, not the first', () => {
    const first = settled(onDragBegin(), 1000);
    const second = settled(onDragBegin(), 2000);
    expect(onTick(first, 1000 + FOLLOW_RESUME_MS).kind).toBe('follow');
    expect(onTick(second, 1000 + FOLLOW_RESUME_MS).kind).toBe('settling');
  });

  // The user's call: a tap that seeks does not restart the countdown, it ends
  // it — the line they picked is the line that is playing now.
  it('follows again the moment a seek happens, without waiting out the timer', () => {
    const waiting = settled(onDragBegin(), 1000);
    expect(isFollowing(onSeek())).toBe(true);
    expect(isFollowing(onTick(waiting, 1500))).toBe(false);
  });
});
