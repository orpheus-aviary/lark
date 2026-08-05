import { describe, expect, it } from 'vitest';
import { createDownloadStatusDedupe, parseLarkEvent } from './events.js';

describe('parseLarkEvent', () => {
  it('parses a well-formed event', () => {
    expect(parseLarkEvent('{"type":"songs:changed"}')).toEqual({ type: 'songs:changed' });
  });

  it('passes unknown event types through (forward compatibility)', () => {
    expect(parseLarkEvent('{"type":"future:thing","x":1}')).toMatchObject({
      type: 'future:thing',
    });
  });

  it.each([
    ['not JSON', 'garbage{'],
    ['a JSON string', '"hello"'],
    ['an array', '[1,2]'],
    ['null', 'null'],
    ['missing type', '{"song_id":"x"}'],
    ['non-string type', '{"type":42}'],
  ])('returns null for %s', (_label, raw) => {
    expect(parseLarkEvent(raw)).toBeNull();
  });
});

describe('createDownloadStatusDedupe', () => {
  const ev = (task_id: string, state: string, stage: string | null, revision: number) => ({
    task_id,
    state,
    stage,
    revision,
  });

  it('drops an exact repeat of the same task tuple', () => {
    const dedupe = createDownloadStatusDedupe();
    expect(dedupe.isFresh(ev('t1', 'running', 'downloading', 3))).toBe(true);
    expect(dedupe.isFresh(ev('t1', 'running', 'downloading', 3))).toBe(false);
  });

  it('a revision bump on the same (state, stage) is fresh', () => {
    const dedupe = createDownloadStatusDedupe();
    expect(dedupe.isFresh(ev('t1', 'running', 'resolving', 2))).toBe(true);
    expect(dedupe.isFresh(ev('t1', 'running', 'resolving', 3))).toBe(true);
  });

  it('partitions by task: parallel tasks may agree on (state, stage, revision)', () => {
    const dedupe = createDownloadStatusDedupe();
    expect(dedupe.isFresh(ev('t1', 'running', 'downloading', 5))).toBe(true);
    expect(dedupe.isFresh(ev('t2', 'running', 'downloading', 5))).toBe(true);
    expect(dedupe.isFresh(ev('t1', 'running', 'downloading', 5))).toBe(false);
  });

  it('distinguishes null stage from the string form', () => {
    const dedupe = createDownloadStatusDedupe();
    expect(dedupe.isFresh(ev('t1', 'queued', null, 1))).toBe(true);
    expect(dedupe.isFresh(ev('t1', 'queued', null, 1))).toBe(false);
  });

  it('clear() forgets everything (epoch reset)', () => {
    const dedupe = createDownloadStatusDedupe();
    dedupe.isFresh(ev('t1', 'running', 'saving', 9));
    dedupe.clear();
    expect(dedupe.isFresh(ev('t1', 'running', 'saving', 9))).toBe(true);
  });
});
