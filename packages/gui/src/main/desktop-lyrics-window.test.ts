// ⑤ — the lifecycle, which is the half of this window that has no pixels.

import type { DesktopLyricsConfig } from '@lark/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopLyricsMessage } from '../shared/desktop-lyrics.js';
import { DesktopLyricsController, type DesktopLyricsWindow } from './desktop-lyrics-window.js';

const CONFIG: DesktopLyricsConfig = {
  enabled: true,
  lines: 1,
  font_size: 32,
  preset: 'classic',
  locked: false,
  x: 0,
  y: 0,
  width: 900,
  height: 120,
};

const message = (index: number): DesktopLyricsMessage => ({
  config: CONFIG,
  song: { name: '稻香', artist: '周杰伦' },
  lyrics: [
    { time: 0, text: '一' },
    { time: 5, text: '二' },
  ],
  index,
  playing: true,
});

function harness() {
  const built: {
    window: DesktopLyricsWindow;
    published: DesktopLyricsMessage[];
    destroyed: boolean;
  }[] = [];
  const onClosedByUser = vi.fn();
  const controller = new DesktopLyricsController({
    create: () => {
      const entry = {
        published: [] as DesktopLyricsMessage[],
        destroyed: false,
        window: {} as DesktopLyricsWindow,
      };
      entry.window = {
        isDestroyed: () => entry.destroyed,
        destroy: () => {
          entry.destroyed = true;
        },
        publish: (state) => entry.published.push(state),
      };
      built.push(entry);
      return entry.window;
    },
    onClosedByUser,
  });
  return { controller, built, onClosedByUser };
}

describe('the desktop lyrics window', () => {
  it('opens when the config says so', () => {
    const h = harness();
    h.controller.apply(CONFIG);
    expect(h.built).toHaveLength(1);
  });

  it('does not open a second one for a config that still says so', () => {
    const h = harness();
    h.controller.apply(CONFIG);
    h.controller.apply({ ...CONFIG, font_size: 40 });
    expect(h.built).toHaveLength(1);
  });

  it('takes it away when the config turns it off', () => {
    const h = harness();
    h.controller.apply(CONFIG);
    h.controller.apply({ ...CONFIG, enabled: false });
    expect(h.built[0]?.destroyed).toBe(true);
  });

  it('opens a new one after being turned off and on again', () => {
    const h = harness();
    h.controller.apply(CONFIG);
    h.controller.apply({ ...CONFIG, enabled: false });
    h.controller.apply(CONFIG);
    expect(h.built).toHaveLength(2);
  });

  it('does nothing at all while it is off', () => {
    const h = harness();
    h.controller.apply({ ...CONFIG, enabled: false });
    h.controller.publish(message(0));
    expect(h.built).toHaveLength(0);
  });

  // A window opened in the middle of a song has to show that song, not wait
  // for the next line — which on a slow ballad is a long look at nothing.
  it('replays the last frame into a window that opens mid-song', () => {
    const h = harness();
    h.controller.publish(message(1));
    h.controller.apply(CONFIG);
    expect(h.built[0]?.published).toEqual([message(1)]);
  });

  it('forwards what comes after that', () => {
    const h = harness();
    h.controller.apply(CONFIG);
    h.controller.publish(message(0));
    h.controller.publish(message(1));
    expect(h.built[0]?.published.map((state) => state.index)).toEqual([0, 1]);
  });

  // 🔴 Closing it IS turning the feature off, so it has to be told apart from
  // us taking it down — otherwise quitting the app would switch the feature
  // off for good, because Electron closes every window on the way out.
  it('reports a close nobody asked for', () => {
    const h = harness();
    h.controller.apply(CONFIG);
    h.controller.noteClosed(h.built[0]?.window as DesktopLyricsWindow);
    expect(h.onClosedByUser).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the close was ours', () => {
    const h = harness();
    h.controller.apply(CONFIG);
    h.controller.close();
    h.controller.noteClosed(h.built[0]?.window as DesktopLyricsWindow);
    expect(h.onClosedByUser).not.toHaveBeenCalled();
  });

  it('opens again after a close nobody asked for', () => {
    const h = harness();
    h.controller.apply(CONFIG);
    h.controller.noteClosed(h.built[0]?.window as DesktopLyricsWindow);
    h.controller.apply(CONFIG);
    expect(h.built).toHaveLength(2);
  });

  // A window destroyed under us — a crashed renderer, a devtools reload — is
  // not a window, and the next config pass has to build one.
  it('replaces a window that died on its own', () => {
    const h = harness();
    h.controller.apply(CONFIG);
    const entry = h.built[0];
    if (entry) entry.destroyed = true;
    h.controller.apply(CONFIG);
    expect(h.built).toHaveLength(2);
  });
});
