// The M4-8 recovery state machine, including the failure terminals the plan
// insists on: metadata that never arrives, and a play() that rejects.

import { describe, expect, it, vi } from 'vitest';
import type { MediaElement } from './media.js';
import { runRecovery } from './recovery.js';

interface FakeMedia extends MediaElement {
  emit(type: string): void;
  duration: number;
}

function fakeMedia(overrides: Partial<MediaElement> = {}): FakeMedia {
  const listeners = new Map<string, Set<() => void>>();
  return {
    src: '',
    currentTime: 0,
    duration: 200,
    load: vi.fn(),
    pause: vi.fn(),
    removeAttribute: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    ...overrides,
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('successful recovery', () => {
  it('restores position and resumes when that was the intent', async () => {
    const audio = fakeMedia();
    const promise = runRecovery({
      audio,
      src: 'lark-media://song/abc',
      position: 42,
      resume: true,
      isCurrent: () => true,
    });
    await tick();
    audio.emit('loadedmetadata');

    await expect(promise).resolves.toEqual({ ok: true });
    expect(audio.src).toBe('lark-media://song/abc');
    expect(audio.currentTime).toBe(42);
    expect(audio.play).toHaveBeenCalled();
  });

  it('stays paused when the session was paused before the restart', async () => {
    const audio = fakeMedia();
    const promise = runRecovery({
      audio,
      src: 'lark-media://song/abc',
      position: 10,
      resume: false,
      isCurrent: () => true,
    });
    await tick();
    audio.emit('loadedmetadata');

    await expect(promise).resolves.toEqual({ ok: true });
    expect(audio.play).not.toHaveBeenCalled();
  });

  it('clamps a saved position past the new duration', async () => {
    const audio = fakeMedia({ duration: 30 });
    const promise = runRecovery({
      audio,
      src: 'lark-media://song/abc',
      position: 500,
      resume: false,
      isCurrent: () => true,
    });
    await tick();
    audio.emit('loadedmetadata');
    await promise;

    expect(audio.currentTime).toBe(30);
  });
});

describe('failure terminals', () => {
  it('gives up when metadata never arrives', async () => {
    vi.useFakeTimers();
    try {
      const audio = fakeMedia();
      const promise = runRecovery({
        audio,
        src: 'lark-media://song/abc',
        position: 5,
        resume: true,
        isCurrent: () => true,
        timeoutMs: 10_000,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(promise).resolves.toEqual({
        ok: false,
        reason: 'timeout',
        message: '媒体加载超时',
      });
      expect(audio.play).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles on the element error rather than waiting out the timeout', async () => {
    const audio = fakeMedia();
    const promise = runRecovery({
      audio,
      src: 'lark-media://song/abc',
      position: 5,
      resume: true,
      isCurrent: () => true,
    });
    await tick();
    audio.emit('error');

    await expect(promise).resolves.toEqual({
      ok: false,
      reason: 'error',
      message: '媒体加载失败',
    });
  });

  it('reports a rejected play() instead of hanging on it', async () => {
    const audio = fakeMedia({ play: vi.fn(() => Promise.reject(new Error('NotAllowedError'))) });
    const promise = runRecovery({
      audio,
      src: 'lark-media://song/abc',
      position: 5,
      resume: true,
      isCurrent: () => true,
    });
    await tick();
    audio.emit('loadedmetadata');

    await expect(promise).resolves.toEqual({
      ok: false,
      reason: 'play-rejected',
      message: 'NotAllowedError',
    });
  });
});

describe('two generations in a row', () => {
  it('drops the older run once a newer generation takes over', async () => {
    const audio = fakeMedia();
    let generation = 1;
    const first = runRecovery({
      audio,
      src: 'lark-media://song/abc',
      position: 7,
      resume: true,
      isCurrent: () => generation === 1,
    });

    // A second daemon restart lands before the first recovery settles.
    generation = 2;
    await tick();
    audio.emit('loadedmetadata');

    await expect(first).resolves.toEqual({ ok: false, reason: 'superseded', message: '' });
    expect(audio.currentTime).toBe(0); // the stale run never touched the element
    expect(audio.play).not.toHaveBeenCalled();

    const second = runRecovery({
      audio,
      src: 'lark-media://song/abc',
      position: 7,
      resume: true,
      isCurrent: () => generation === 2,
    });
    await tick();
    audio.emit('loadedmetadata');
    await expect(second).resolves.toEqual({ ok: true });
    expect(audio.currentTime).toBe(7);
  });
});
