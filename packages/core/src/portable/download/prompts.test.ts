// The prompts are ported text, so what is worth asserting is that the
// load-bearing instructions survived the port — the ones a paraphrase would
// quietly drop and only a bad download would reveal.

import { describe, expect, it } from 'vitest';
import {
  ANALYZE_PROMPT,
  BATCH_ANALYZE_PROMPT,
  INFER_SONG_INFO_PROMPT,
  formatDuration,
  lyricsSelectPrompt,
  multiPPrompt,
  selectPrompt,
} from './prompts.js';

describe('prompt interpolation', () => {
  it('puts the target song into the select prompt', () => {
    const p = selectPrompt('稻香', '周杰伦');
    expect(p).toContain('名称="稻香"');
    expect(p).toContain('创作者="周杰伦"');
    expect(p).toContain('NONE'); // the "nothing matched" escape hatch
  });

  it('asks the multi-P prompt for a bare number', () => {
    const p = multiPPrompt('稻香', '周杰伦');
    expect(p).toContain('歌名="稻香"');
    expect(p).toContain('纯数字');
  });

  it('carries the audio duration and the ±30s rule into the lyrics prompt', () => {
    const p = lyricsSelectPrompt('稻香', '周杰伦', 223);
    expect(p).toContain('音频时长=3:43');
    expect(p).toContain('超过30秒');
    expect(p).toContain('end_time');
  });

  // ⑧ — a duet used to come back with one of its two singers, whichever the
  // model felt like. Only a real model can show that this reads the way it is
  // meant to; what a laptop can hold is that the rule is still in the text.
  it('tells the naming prompt to keep every artist', () => {
    expect(INFER_SONG_INFO_PROMPT).toContain('多个创作者');
    expect(INFER_SONG_INFO_PROMPT).toContain('、');
  });

  it('keeps every prompt asking for un-fenced output', () => {
    for (const p of [ANALYZE_PROMPT, INFER_SONG_INFO_PROMPT, BATCH_ANALYZE_PROMPT]) {
      expect(p).toContain('不要markdown代码块');
    }
  });
});

describe('formatDuration', () => {
  it('renders M:SS with a zero-padded second', () => {
    expect(formatDuration(223)).toBe('3:43');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(59.6)).toBe('1:00'); // rounds, then carries
  });

  it('says 未知 for an unknown duration rather than 0:00', () => {
    expect(formatDuration(0)).toBe('未知');
    expect(formatDuration(-1)).toBe('未知');
    expect(formatDuration(Number.NaN)).toBe('未知');
  });
});
