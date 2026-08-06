// `[theme] mode` → the `.dark` class (M5-2): 'system' follows the OS, a forced
// light/dark must ignore it entirely.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyThemeMode, watchTheme } from './theme.js';

interface FakeQuery {
  matches: boolean;
  listeners: Set<(e: MediaQueryListEvent) => void>;
}

let query: FakeQuery;

/** Install a matchMedia whose change events we can fire by hand. */
function stubMatchMedia(dark: boolean): void {
  query = { matches: dark, listeners: new Set() };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: query.matches,
      media: '(prefers-color-scheme: dark)',
      addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) =>
        query.listeners.add(fn),
      removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) =>
        query.listeners.delete(fn),
    })),
  );
}

function fireSystemChange(dark: boolean): void {
  query.matches = dark;
  for (const fn of query.listeners) fn({ matches: dark } as MediaQueryListEvent);
}

const isDark = (): boolean => document.documentElement.classList.contains('dark');

beforeEach(() => {
  stubMatchMedia(false);
  document.documentElement.classList.remove('dark');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('applyThemeMode', () => {
  it("resolves 'system' against the OS preference", () => {
    applyThemeMode('system');
    expect(isDark()).toBe(false);

    stubMatchMedia(true);
    applyThemeMode('system');
    expect(isDark()).toBe(true);
  });

  it('forces light/dark regardless of the OS', () => {
    stubMatchMedia(true);
    applyThemeMode('light');
    expect(isDark()).toBe(false);

    stubMatchMedia(false);
    applyThemeMode('dark');
    expect(isDark()).toBe(true);
  });
});

describe('watchTheme', () => {
  it("'system' follows later OS changes and unlistens on teardown", () => {
    const stop = watchTheme('system');
    expect(isDark()).toBe(false);

    fireSystemChange(true);
    expect(isDark()).toBe(true);

    stop();
    expect(query.listeners.size).toBe(0);
    fireSystemChange(false);
    expect(isDark()).toBe(true); // no listener left: the class stays put
  });

  it('a forced mode never subscribes — an OS flip cannot override it', () => {
    const stop = watchTheme('dark');
    expect(isDark()).toBe(true);
    expect(query.listeners.size).toBe(0);

    fireSystemChange(false);
    expect(isDark()).toBe(true);
    stop();
  });
});
