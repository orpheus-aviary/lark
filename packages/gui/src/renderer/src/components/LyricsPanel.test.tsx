// The offset badge (§7 F8 — criterion 42). The rest of the panel is three
// lines of text driven by `currentLrcIndex`, which has its own tests in
// @lark/shared; what needed one here is the badge's disappearance.

import type { SongData } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayer } from '../stores/player.js';
import { LyricsPanel } from './LyricsPanel.js';

function song(offset: number): SongData {
  return {
    id: 's1',
    name: '温柔',
    artist: '五月天',
    source_url: null,
    source_provider: null,
    source_key: null,
    file_origin: 'downloaded',
    lyrics_offset: offset,
    duration: 250,
    pinned: false,
    created_at: 1,
    updated_at: 1,
  };
}

/** Put a song on screen with this offset, as an adjustment would. */
function withOffset(offset: number): void {
  usePlayer.setState({
    currentSong: song(offset),
    currentTime: 0,
    lyrics: [{ time: 0, text: '走在风中' }],
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  withOffset(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the offset badge', () => {
  it('appears on an adjustment and fades on its own', async () => {
    render(<LyricsPanel />);
    expect(screen.queryByText('+0.5s')).toBeNull();

    withOffset(0.5);
    expect(await screen.findByText('+0.5s')).toBeDefined();

    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => expect(screen.queryByText('+0.5s')).toBeNull());
  });

  // The bug: stepping back to zero returned early — the badge kept showing the
  // number BEFORE the step, and stayed until the next adjustment or a fade
  // that was never scheduled.
  it('goes away when the offset is stepped back to zero', async () => {
    render(<LyricsPanel />);

    withOffset(0.5);
    expect(await screen.findByText('+0.5s')).toBeDefined();

    withOffset(0);
    await waitFor(() => expect(screen.queryByText('+0.5s')).toBeNull());
    expect(screen.queryByText('0.0s')).toBeNull();
  });
});
