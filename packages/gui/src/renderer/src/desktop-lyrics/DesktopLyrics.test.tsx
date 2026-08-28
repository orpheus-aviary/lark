// ⑤ — what the floating window offers, and what it stops offering once it is
// locked. The window's own pixels are a device question; this is the wiring.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopLyricsMessage } from '../../../shared/desktop-lyrics.js';
import { DesktopLyrics } from './DesktopLyrics.js';

let publish: ((message: DesktopLyricsMessage) => void) | null = null;
let changes: unknown[] = [];

const message = (
  overrides: Partial<DesktopLyricsMessage['config']> = {},
): DesktopLyricsMessage => ({
  config: {
    enabled: true,
    lines: 1,
    font_size: 32,
    preset: 'classic',
    locked: false,
    x: 0,
    y: 0,
    width: 900,
    height: 120,
    ...overrides,
  },
  song: { name: '稻香', artist: '周杰伦' },
  lyrics: [
    { time: 0, text: '第一句' },
    { time: 5, text: '第二句' },
  ],
  index: 0,
  playing: true,
});

beforeEach(() => {
  publish = null;
  changes = [];
  // Replaced wholesale rather than field by field: the bridge is `readonly`
  // on purpose, and `TopBar.test.tsx` set the precedent for standing in for it.
  window.larkAPI = {
    ...window.larkAPI,
    onDesktopLyrics: vi.fn((listener: (message: DesktopLyricsMessage) => void) => {
      publish = listener;
      return () => {};
    }),
    requestDesktopLyricsChange: vi.fn((change: unknown) => {
      changes.push(change);
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Render, hand it its first frame the way main does, and put the pointer on
 * it.
 *
 * `fireEvent` rather than `userEvent` for the hover: the control bar unmounts
 * on `mouseleave`, and a simulated pointer that walks from one subtree to
 * another can take the bar away between the press and the click.
 */
function show(config: Partial<DesktopLyricsMessage['config']> = {}): HTMLElement {
  const { container } = render(<DesktopLyrics />);
  act(() => publish?.(message(config)));
  const window_ = container.querySelector('.lyrics-window') as HTMLElement;
  fireEvent.mouseEnter(window_);
  return window_;
}

const button = (name: string): HTMLElement => screen.getByRole('button', { name });

describe('the floating lyric window', () => {
  it('draws the line that is playing, twice — the outline and the fill', () => {
    show();
    expect(screen.getAllByText('第一句')).toHaveLength(2);
  });

  it('adds the line after it when asked for two', () => {
    show({ lines: 2 });
    expect(screen.getAllByText('第二句')).toHaveLength(2);
  });

  // 🔴 Locked means the window is not there as far as the mouse is concerned,
  // so a control bar on it would be a button that cannot be pressed.
  it('offers nothing at all once it is locked', () => {
    show({ locked: true });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers its controls on hover while it is unlocked', () => {
    show();
    expect(button('A+')).toBeDefined();
    expect(button('配色')).toBeDefined();
    expect(button('关闭')).toBeDefined();
  });

  it('asks for a bigger font rather than setting one itself', () => {
    show();
    fireEvent.click(button('A+'));
    expect(changes).toEqual([{ font_size: 36 }]);
  });

  it('walks the four schemes in a circle', () => {
    show({ preset: 'plain' });
    fireEvent.click(button('配色'));
    expect(changes).toEqual([{ preset: 'classic' }]);
  });

  // The user's decision, said at the moment it starts being true: there is no
  // way back from this window once it is locked.
  it('says what locking costs before it locks', () => {
    show();
    fireEvent.click(button('锁定'));

    expect(screen.getByText('锁定后点不到它了，解锁要回设置页')).toBeDefined();
    expect(changes).toEqual([]);

    fireEvent.click(button('锁定'));
    expect(changes).toEqual([{ locked: true }]);
  });

  it('closes by asking to be turned off, not by hiding', () => {
    show();
    fireEvent.click(button('关闭'));
    expect(changes).toEqual([{ enabled: false }]);
  });

  it('names the song while it has no line to show', () => {
    render(<DesktopLyrics />);
    act(() => publish?.({ ...message(), index: -1 }));
    expect(screen.getAllByText('稻香')).toHaveLength(2);
  });

  it('draws nothing at all with nothing playing', () => {
    render(<DesktopLyrics />);
    act(() => publish?.({ ...message(), song: null }));
    expect(screen.queryByText('第一句')).toBeNull();
  });
});
