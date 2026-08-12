import { describe, expect, it } from 'vitest';
import { formatDateTime, formatRelativeTime } from './format.js';

describe('formatRelativeTime', () => {
  const now = 1_700_000_000_000;

  it('collapses anything under a minute into 刚刚', () => {
    expect(formatRelativeTime(now - 59_000, now)).toBe('刚刚');
  });

  it('counts minutes, then hours', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前');
  });

  // "97 小时前" stopped being readable long before it stopped being accurate.
  it('falls back to the absolute stamp past a day', () => {
    const then = now - 4 * 86_400_000;
    expect(formatRelativeTime(then, now)).toBe(formatDateTime(then));
  });

  // A daemon whose clock jumped backwards must not produce "-3 分钟前".
  it('treats a future timestamp as just now', () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe('刚刚');
  });

  it('says nothing for a missing timestamp', () => {
    expect(formatRelativeTime(0, now)).toBe('');
  });
});
