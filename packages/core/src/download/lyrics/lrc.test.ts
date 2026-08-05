import { describe, expect, it } from 'vitest';
import { lrcEndTime, lrcPreview, lrcTailPreview, normalizeLrc, toCandidate } from './lrc.js';

const LRC = [
  '[ti:稻香]',
  '[ar:周杰伦]',
  '[00:00.00]稻香 - 周杰伦',
  '[00:12.34]对这个世界如果你有太多的抱怨',
  '[00:16.50]跌倒了就不敢继续往前走',
  '[00:20.10]为什么人要这么的脆弱 堕落',
  '[03:40.00]还记得你说家是唯一的城堡',
].join('\n');

describe('normalizeLrc', () => {
  it('strips the BOM and normalises line endings', () => {
    const normalised = normalizeLrc('﻿[00:01.00]a\r\n[00:02.00]b\r[00:03.00]c');
    expect(normalised).toBe('[00:01.00]a\n[00:02.00]b\n[00:03.00]c');
  });

  it('rejects empty and untimed text', () => {
    expect(normalizeLrc('')).toBeNull();
    expect(normalizeLrc('   ')).toBeNull();
    expect(normalizeLrc('just the lyrics, no timestamps')).toBeNull();
  });

  // The Go rule was `contains("[0")`. It let a plain-text file through on the
  // literal characters and rejected lyrics that only start after 09:59.
  it('accepts a first timestamp past the ten-minute mark', () => {
    expect(normalizeLrc('[12:30.00]late start')).not.toBeNull();
  });

  it('rejects a bracket that only looks like a timestamp', () => {
    expect(normalizeLrc('[00]a\n[0abc]b')).toBeNull();
  });

  it('accepts both the . and : fractional separators', () => {
    expect(normalizeLrc('[00:12.34]a')).not.toBeNull();
    expect(normalizeLrc('[00:12:340]a')).not.toBeNull();
  });
});

describe('lrcEndTime', () => {
  it('reads the last timestamp in both forms', () => {
    expect(lrcEndTime(LRC)).toEqual({ text: '3:40', seconds: 220 });
    expect(lrcEndTime('[00:05.00]a')).toEqual({ text: '0:05', seconds: 5 });
  });

  it('returns null when there is no timestamp at all', () => {
    expect(lrcEndTime('nothing here')).toBeNull();
  });
});

describe('previews', () => {
  it('skips metadata tags and empty lines', () => {
    expect(lrcPreview(LRC, 2)).toBe('稻香 - 周杰伦 / 对这个世界如果你有太多的抱怨');
  });

  it('reads the tail, which is where truncation shows', () => {
    expect(lrcTailPreview(LRC, 2)).toBe('为什么人要这么的脆弱 堕落 / 还记得你说家是唯一的城堡');
  });

  it('returns everything when asked for more lines than exist', () => {
    expect(lrcTailPreview('[00:01.00]only', 5)).toBe('only');
  });
});

describe('toCandidate', () => {
  it('builds a full candidate from raw lrc', () => {
    const candidate = toCandidate('netease', '稻香', '周杰伦', LRC);
    expect(candidate).toMatchObject({
      platform: 'netease',
      songName: '稻香',
      artist: '周杰伦',
      endTime: '3:40',
      endSeconds: 220,
    });
    expect(candidate?.preview).toContain('稻香');
  });

  it('drops a hit whose lyrics are untimed', () => {
    expect(toCandidate('qq', '稻香', '周杰伦', 'plain text lyrics')).toBeNull();
  });
});
