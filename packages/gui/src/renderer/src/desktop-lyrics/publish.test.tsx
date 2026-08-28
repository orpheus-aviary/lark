// ⑤ — what the main window tells the floating one, and how often.

import type { PublicLarkConfig, SongData } from '@lark/shared';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopLyricsMessage } from '../../../shared/desktop-lyrics.js';
import { useConfig } from '../stores/config.js';
import { usePlayer } from '../stores/player.js';
import { useSettingsUi } from '../stores/settings-ui.js';
import { useDesktopLyricsPublisher } from './publish.js';

const SONG: SongData = {
  id: 's1',
  name: '稻香',
  artist: '周杰伦',
  source_url: null,
  source_provider: null,
  source_key: null,
  file_origin: 'downloaded',
  lyrics_offset: 0,
  duration: 240,
  pinned: false,
  created_at: 0,
  updated_at: 0,
};

const config = {
  desktop_lyrics: {
    enabled: true,
    lines: 1,
    font_size: 32,
    preset: 'classic',
    locked: false,
    x: 0,
    y: 0,
    width: 900,
    height: 120,
  },
} as PublicLarkConfig;

let published: DesktopLyricsMessage[] = [];

beforeEach(() => {
  published = [];
  window.larkAPI = {
    ...window.larkAPI,
    publishDesktopLyrics: vi.fn((message: DesktopLyricsMessage) => {
      published.push(message);
    }),
  };
  useConfig.setState({ config });
  useSettingsUi.setState({ lyricsPreview: null });
  usePlayer.setState({
    currentSong: SONG,
    lyrics: [
      { time: 0, text: '第一句' },
      { time: 30, text: '第二句' },
    ],
    currentTime: 0,
    isPlaying: true,
  });
});

const latest = (): DesktopLyricsMessage => {
  const last = published.at(-1);
  if (last === undefined) throw new Error('nothing was published');
  return last;
};

describe('driving the floating window', () => {
  it('sends the saved config with the line that is playing', () => {
    renderHook(() => useDesktopLyricsPublisher());
    expect(latest().config.font_size).toBe(32);
    expect(latest().index).toBe(0);
  });

  // The settings page's draft rides the same channel as everything else — it
  // is shown by publishing it, never by writing it.
  it('sends what the settings page is previewing, over the saved config', () => {
    renderHook(() => useDesktopLyricsPublisher());
    act(() => useSettingsUi.setState({ lyricsPreview: { font_size: 48, preset: 'night' } }));

    expect(latest().config.font_size).toBe(48);
    expect(latest().config.preset).toBe('night');
    // Not previewable, so still whatever is stored.
    expect(latest().config.locked).toBe(false);
  });

  it('goes back to the saved config when the preview is dropped', () => {
    renderHook(() => useDesktopLyricsPublisher());
    act(() => useSettingsUi.setState({ lyricsPreview: { font_size: 48 } }));
    act(() => useSettingsUi.setState({ lyricsPreview: null }));

    expect(latest().config.font_size).toBe(32);
  });

  // 🔴 PER LINE, NOT PER TICK — the property this module is written around.
  // `currentTime` moves four times a second, and anything rebuilt per render
  // (the merged config, once there was one to merge) turns that into forty
  // messages for every one that changes what is drawn.
  it('says nothing while the time moves inside the line it already sent', () => {
    renderHook(() => useDesktopLyricsPublisher());
    // 🔴 WITH A PREVIEW ON, which is the only state where the config handed to
    // the effect is BUILT rather than read: with none, the merge returns the
    // stored object itself and the identity is stable by accident. This test
    // was green against an unmemoised merge until it previewed something.
    act(() => useSettingsUi.setState({ lyricsPreview: { font_size: 48 } }));
    const before = published.length;

    act(() => usePlayer.setState({ currentTime: 5 }));
    act(() => usePlayer.setState({ currentTime: 10 }));
    expect(published).toHaveLength(before);

    act(() => usePlayer.setState({ currentTime: 31 }));
    expect(published).toHaveLength(before + 1);
    expect(latest().index).toBe(1);
  });
});
