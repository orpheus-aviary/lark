// D14: the Go key map, minus its two bugs (Tab swallowed everywhere, and the
// "am I typing?" check running after the Tab branch).

import { fireEvent, render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayer } from '../stores/player.js';
import { useKeyboardShortcuts } from './useKeyboardShortcuts.js';

const togglePlay = vi.fn(() => Promise.resolve({ ok: true }));
const seekBy = vi.fn(() => Promise.resolve({ ok: true }));
const next = vi.fn(() => Promise.resolve({ ok: true }));
const prev = vi.fn(() => Promise.resolve({ ok: true }));

beforeEach(() => {
  togglePlay.mockClear();
  seekBy.mockClear();
  next.mockClear();
  prev.mockClear();
  usePlayer.setState({ togglePlay, seekBy, next, prev });
  renderHook(() => useKeyboardShortcuts());
});

describe('transport keys', () => {
  it('space toggles playback', () => {
    fireEvent.keyDown(window, { key: ' ' });
    expect(togglePlay).toHaveBeenCalled();
  });

  it('arrows seek by five seconds and change track', () => {
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(seekBy).toHaveBeenNthCalledWith(1, 5);
    expect(seekBy).toHaveBeenNthCalledWith(2, -5);

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(prev).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('leaves shortcuts alone when a modifier is held', () => {
    fireEvent.keyDown(window, { key: ' ', metaKey: true });
    expect(togglePlay).not.toHaveBeenCalled();
  });
});

describe('typing', () => {
  it('does not pause the music when space is typed into a field', () => {
    const { getByRole } = render(<input aria-label="search" />);
    const input = getByRole('textbox');
    input.focus();

    fireEvent.keyDown(input, { key: ' ' });
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it('never swallows Tab — keyboard navigation has to keep working', () => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
