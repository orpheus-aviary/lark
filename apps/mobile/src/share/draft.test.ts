// Criterion 45's logic half, and the rule the whole arrangement rests on
// (N4d-3): a draft is consumed ONCE, and taking it clears it.
//
// The device answers the part only it can — that a share from the real
// bilibili app reaches this at all, on three arrival paths, and that a cold
// start opens on 添加 with it. What is settled here is what happens after: that
// two readers cannot both take it, that the shell's listener does not eat what
// the add page is about to read, and that nothing survives a process.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasShareDraft, putShareDraft, subscribeShareDraft, takeShareDraft } from './draft';

beforeEach(() => {
  // The singleton is module state; each case starts from empty.
  takeShareDraft();
});

describe('a draft is consumed once', () => {
  it('hands the text to the first taker and nothing to the second', () => {
    putShareDraft('https://b23.tv/cfzPKZX');
    expect(takeShareDraft()).toBe('https://b23.tv/cfzPKZX');
    expect(takeShareDraft()).toBeNull();
  });

  it('reports whether one is waiting without consuming it', () => {
    putShareDraft('x');
    expect(hasShareDraft()).toBe(true);
    // The shell asks this to pick a tab; if asking took the draft, the tab it
    // switched to would open on an empty box.
    expect(hasShareDraft()).toBe(true);
    expect(takeShareDraft()).toBe('x');
    expect(hasShareDraft()).toBe(false);
  });

  it('keeps the newest share when two arrive before anyone reads', () => {
    putShareDraft('first');
    putShareDraft('second');
    expect(takeShareDraft()).toBe('second');
  });
});

describe('what is not a draft', () => {
  it('ignores an empty share', () => {
    putShareDraft('');
    expect(hasShareDraft()).toBe(false);
  });

  it('ignores a share that is only whitespace', () => {
    putShareDraft('   \n  ');
    expect(hasShareDraft()).toBe(false);
  });

  it('does not wake anybody for one', () => {
    const listener = vi.fn();
    subscribeShareDraft(listener);
    putShareDraft('');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('telling the screens', () => {
  it('announces an arrival to every listener', () => {
    const shell = vi.fn();
    const page = vi.fn();
    subscribeShareDraft(shell);
    subscribeShareDraft(page);

    putShareDraft('https://b23.tv/x');

    expect(shell).toHaveBeenCalledTimes(1);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('leaves the draft for the listeners to take — announcing is not consuming', () => {
    let seen: string | null = 'not read';
    subscribeShareDraft(() => {
      // The shell's listener, which only switches tab.
    });
    subscribeShareDraft(() => {
      seen = takeShareDraft();
    });

    putShareDraft('https://b23.tv/x');
    expect(seen).toBe('https://b23.tv/x');
  });

  it('stops telling a listener that unsubscribed', () => {
    const gone = vi.fn();
    subscribeShareDraft(gone)();
    putShareDraft('x');
    expect(gone).not.toHaveBeenCalled();
  });
});

describe('criterion 45: it does not come back from the dead', () => {
  it('is gone once taken, so the next mount finds nothing', () => {
    putShareDraft('https://b23.tv/cfzPKZX');
    takeShareDraft();
    // What a cold start would see. Nothing persists it, so there is nothing
    // for a later process to read — which is the criterion, stated as code.
    expect(hasShareDraft()).toBe(false);
    expect(takeShareDraft()).toBeNull();
  });
});
