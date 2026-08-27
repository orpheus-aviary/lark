import type { SongData } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_BYTES_PER_SECOND,
  bytesPerSecondOf,
  describeBudgetPlan,
  planWithinBudget,
  refusedRecord,
} from './budget';

const MB = 1024 * 1024;

const song = (id: string, patch: Partial<SongData> = {}): SongData =>
  ({
    id,
    name: id,
    artist: '许嵩',
    source_url: null,
    source_provider: 'bilibili',
    source_key: 'BV1:1',
    file_origin: 'downloaded',
    lyrics_offset: 0,
    duration: 240,
    pinned: false,
    created_at: 0,
    updated_at: 0,
    has_file: false,
    ...patch,
  }) as SongData;

/** 240s at 16KB/s ≈ 3.75MB per song. */
const input = (usedMb: number, limitMb: number) => ({
  usedBytes: usedMb * MB,
  limitBytes: limitMb * MB,
  bytesPerSecond: FALLBACK_BYTES_PER_SECOND,
});

describe('planWithinBudget', () => {
  it('queues everything when the limit is unlimited', () => {
    const plan = planWithinBudget([song('a'), song('b')], input(9999, 0));
    expect(plan.queue).toHaveLength(2);
    expect(plan.refused).toHaveLength(0);
  });

  it('stops at the first song that will not fit, and refuses the rest', () => {
    // Room for two: 100MB used, a 110MB limit, ~3.75MB each.
    const plan = planWithinBudget([song('a'), song('b'), song('c'), song('d')], input(100, 110));
    expect(plan.queue.map((s) => s.id)).toEqual(['a', 'b']);
    expect(plan.refused.map((s) => s.id)).toEqual(['c', 'd']);
  });

  it('does not cherry-pick a smaller song past the one that did not fit', () => {
    // 🔴 Skipping ahead would make 「已排 N 首」 mean an arbitrary N.
    const plan = planWithinBudget(
      [song('huge', { duration: 3600 }), song('tiny', { duration: 10 })],
      input(100, 110),
    );
    expect(plan.queue).toHaveLength(0);
    expect(plan.refused.map((s) => s.id)).toEqual(['huge', 'tiny']);
  });

  it('counts what is already on the device, not just this batch', () => {
    // The same playlist and the same limit; only the disk differs.
    const roomy = planWithinBudget([song('a'), song('b')], input(0, 110));
    const full = planWithinBudget([song('a'), song('b')], input(109, 110));
    expect(roomy.queue).toHaveLength(2);
    expect(full.queue).toHaveLength(0);
  });

  it('leaves out the songs that are already here', () => {
    const plan = planWithinBudget([song('here', { has_file: true }), song('a')], input(0, 0));
    expect(plan.queue.map((s) => s.id)).toEqual(['a']);
    expect(plan.refused).toHaveLength(0);
    expect(plan.unavailable).toHaveLength(0);
  });

  it('sets aside the ones with nowhere to fetch from', () => {
    // An imported file the user brought in has no source key; downloading it
    // is not something the limit refused, it is something nobody can do.
    const plan = planWithinBudget([song('mine', { source_key: null }), song('a')], input(0, 0));
    expect(plan.unavailable.map((s) => s.id)).toEqual(['mine']);
    expect(plan.queue.map((s) => s.id)).toEqual(['a']);
  });
});

describe('bytesPerSecondOf', () => {
  it('measures this device rather than guessing', () => {
    const measured = bytesPerSecondOf([
      song('a', { has_file: true, file_size: 2_400_000, duration: 240 }),
      song('b', { has_file: true, file_size: 1_200_000, duration: 120 }),
    ]);
    expect(measured).toBe(10_000);
  });

  it('falls back when there is nothing to measure', () => {
    expect(bytesPerSecondOf([])).toBe(FALLBACK_BYTES_PER_SECOND);
    expect(bytesPerSecondOf([song('a')])).toBe(FALLBACK_BYTES_PER_SECOND);
  });

  it('ignores a row with no duration rather than dividing by zero', () => {
    // Dividing by zero would make every song free, so the batch would queue
    // the whole library and blow straight past the limit.
    const measured = bytesPerSecondOf([
      song('broken', { has_file: true, file_size: 5_000_000, duration: 0 }),
    ]);
    expect(measured).toBe(FALLBACK_BYTES_PER_SECOND);
  });
});

describe('what it leaves behind', () => {
  it('gives a refused song a row that says what to do about it', () => {
    const record = refusedRecord(song('a'), 900, 5);
    expect(record.error_code).toBe('CACHE_LIMIT');
    expect(record.error_message).toContain('900MB');
    expect(record.state).toBe('failed');
    expect(record.input).toEqual({ type: 'song', song_id: 'a' });
  });

  it('replaces its own row on a second tap rather than stacking one', () => {
    expect(refusedRecord(song('a'), 900, 5).id).toBe(refusedRecord(song('a'), 900, 99).id);
  });

  it('says both halves, or the one that happened', () => {
    const plan = (queue: number, refused: number, unavailable: number) => ({
      queue: Array.from({ length: queue }, (_, i) => song(`q${i}`)),
      refused: Array.from({ length: refused }, (_, i) => song(`r${i}`)),
      unavailable: Array.from({ length: unavailable }, (_, i) => song(`u${i}`)),
    });
    expect(describeBudgetPlan(plan(3, 0, 0))).toBe('已排 3 首');
    expect(describeBudgetPlan(plan(3, 2, 0))).toBe('已排 3 首；2 首到了缓存上限');
    expect(describeBudgetPlan(plan(3, 2, 1))).toBe('已排 3 首；2 首到了缓存上限，1 首没有来源');
    expect(describeBudgetPlan(plan(0, 0, 0))).toBe('这个歌单里的歌都已经在本机了');
    expect(describeBudgetPlan(plan(0, 0, 2))).toBe('没有可以下载的：2 首没有来源');
  });
});
