// M4-13④ frozen time-axis semantics — each rule in the freeze has a test.

import { describe, expect, it } from 'vitest';
import { currentLrcIndex, hasLrcTimestamps, parseLrc } from './lrc.js';

describe('parseLrc', () => {
  it('parses a plain timed file in order', () => {
    const lines = parseLrc('[00:01.00]one\n[00:02.50]two\n[01:00.00]three');
    expect(lines).toEqual([
      { time: 1, text: 'one' },
      { time: 2.5, text: 'two' },
      { time: 60, text: 'three' },
    ]);
  });

  it('expands a line with several time tags into one entry per tag', () => {
    const lines = parseLrc('[00:10.00][00:30.00][01:10.00]chorus');
    expect(lines).toEqual([
      { time: 10, text: 'chorus' },
      { time: 30, text: 'chorus' },
      { time: 70, text: 'chorus' },
    ]);
  });

  it('sorts by time when tags are out of order', () => {
    const lines = parseLrc('[00:30.00]late\n[00:10.00]early');
    expect(lines.map((l) => l.text)).toEqual(['early', 'late']);
  });

  it('reads 2 fractional digits as centiseconds and 3 as milliseconds', () => {
    const lines = parseLrc('[00:01.50]centi\n[00:02.500]milli\n[00:03:25]colon');
    expect(lines[0]?.time).toBeCloseTo(1.5);
    expect(lines[1]?.time).toBeCloseTo(2.5);
    expect(lines[2]?.time).toBeCloseTo(3.25); // [mm:ss:xx] colon separator
  });

  it('ignores metadata tags INCLUDING [offset:] — DB lyrics_offset is the only offset', () => {
    const lines = parseLrc('[ti:song]\n[ar:artist]\n[offset:+500]\n[00:01.00]real');
    expect(lines).toEqual([{ time: 1, text: 'real' }]);
  });

  it('keeps timed empty lines — the interlude marker is real semantics', () => {
    const lines = parseLrc('[00:01.00]verse\n[00:05.00]\n[00:20.00]next');
    expect(lines[1]).toEqual({ time: 5, text: '' });
  });

  it('keeps duplicate timestamps in file order (stable sort)', () => {
    const lines = parseLrc('[00:05.00]first\n[00:05.00]second');
    expect(lines.map((l) => l.text)).toEqual(['first', 'second']);
  });

  it('strips BOM and handles CRLF', () => {
    const lines = parseLrc('﻿[00:01.00]a\r\n[00:02.00]b\r');
    expect(lines).toEqual([
      { time: 1, text: 'a' },
      { time: 2, text: 'b' },
    ]);
  });

  it('ignores untimed prose and returns [] for non-LRC text', () => {
    expect(parseLrc('just some text\nanother line')).toEqual([]);
    expect(parseLrc('')).toEqual([]);
  });

  it('is not derailed by repeated calls on different inputs (lastIndex trap)', () => {
    expect(parseLrc('[10:00.00]late-start').length).toBe(1);
    expect(parseLrc('[00:01.00]x').length).toBe(1);
    expect(hasLrcTimestamps('[10:00.00]x')).toBe(true);
    expect(hasLrcTimestamps('[00:01.00]x')).toBe(true);
  });
});

describe('currentLrcIndex', () => {
  const lines = parseLrc('[00:10.00]a\n[00:20.00]b\n[00:30.00]c');

  it('has no current line before the first entry', () => {
    expect(currentLrcIndex(lines, 5, 0)).toBe(-1);
  });

  it('takes the LAST entry with time <= currentTime + offset', () => {
    expect(currentLrcIndex(lines, 10, 0)).toBe(0);
    expect(currentLrcIndex(lines, 19.99, 0)).toBe(0);
    expect(currentLrcIndex(lines, 20, 0)).toBe(1);
    expect(currentLrcIndex(lines, 999, 0)).toBe(2);
  });

  it('applies the offset inside the comparison', () => {
    expect(currentLrcIndex(lines, 8, 2)).toBe(0); // 8 + 2 = 10
    expect(currentLrcIndex(lines, 12, -3)).toBe(-1); // 12 - 3 = 9 < 10
  });

  it('picks the last of equal timestamps', () => {
    const dup = parseLrc('[00:05.00]first\n[00:05.00]second');
    expect(currentLrcIndex(dup, 5, 0)).toBe(1);
  });

  it('handles an empty list', () => {
    expect(currentLrcIndex([], 10, 0)).toBe(-1);
  });
});
