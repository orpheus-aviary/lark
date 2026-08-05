import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asWidthMap, readPref, writePref } from './prefs.js';

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

beforeEach(() => {
  window.localStorage.clear();
});

describe('readPref', () => {
  it('round-trips through the lark.gui. namespace', () => {
    writePref('demo', 1, 'kept');
    expect(window.localStorage.getItem('lark.gui.demo')).toBe('{"version":1,"value":"kept"}');
    expect(readPref('demo', 1, asString, 'fallback')).toBe('kept');
  });

  it('falls back when the entry is missing', () => {
    expect(readPref('absent', 1, asString, 'fallback')).toBe('fallback');
  });

  it('falls back on a version bump — a stale shape must not reach the UI', () => {
    writePref('demo', 1, 'old');
    expect(readPref('demo', 2, asString, 'fallback')).toBe('fallback');
  });

  it('falls back on malformed JSON', () => {
    window.localStorage.setItem('lark.gui.demo', '{not json');
    expect(readPref('demo', 1, asString, 'fallback')).toBe('fallback');
  });

  it('falls back when the parser rejects the value', () => {
    writePref('demo', 1, { unexpected: true });
    expect(readPref('demo', 1, asString, 'fallback')).toBe('fallback');
  });

  it('falls back when localStorage itself throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readPref('demo', 1, asString, 'fallback')).toBe('fallback');
    getItem.mockRestore();
  });
});

describe('writePref', () => {
  it('swallows storage failures — a lost width must not break the drag', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => writePref('demo', 1, 'value')).not.toThrow();
    setItem.mockRestore();
  });
});

describe('asWidthMap', () => {
  it('accepts a map of positive numbers', () => {
    expect(asWidthMap({ name: 120, artist: 90 })).toEqual({ name: 120, artist: 90 });
  });

  it('rejects non-numeric, negative and non-object values', () => {
    expect(asWidthMap({ name: '120' })).toBeNull();
    expect(asWidthMap({ name: -5 })).toBeNull();
    expect(asWidthMap([120])).toBeNull();
    expect(asWidthMap(null)).toBeNull();
  });
});
