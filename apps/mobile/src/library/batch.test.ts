// Criteria 55–57 (the logic half) and 58 (N4i-2).
//
// Two things a device cannot show cheaply: a batch whose third item failed
// (you would have to break one delete on purpose, on a phone, with a real
// library), and the sentence that comes out the other end. Both are decided
// here, in a second.

import type { SongData } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { describeBatch, runBatch } from './batch';
import { copyableLink, openableLink, refusalFor } from './links';

const song = (source_url: string | null): Pick<SongData, 'source_url'> => ({ source_url });

describe('runBatch', () => {
  it('does every id in order and counts them', async () => {
    const seen: string[] = [];
    const outcome = await runBatch(['a', 'b', 'c'], (id) => {
      seen.push(id);
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(outcome).toEqual({ done: 3, failures: [] });
  });

  it('keeps going after a failure — the rest are not the failure`s hostages', async () => {
    const seen: string[] = [];
    const outcome = await runBatch(['a', 'b', 'c'], (id) => {
      seen.push(id);
      if (id === 'b') throw new Error('这首正在下载');
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(outcome).toEqual({ done: 2, failures: ['这首正在下载'] });
  });

  it('reports progress after each one, failures included', async () => {
    const steps: [number, number][] = [];
    await runBatch(
      ['a', 'b'],
      (id) => {
        if (id === 'a') throw new Error('x');
      },
      (done, total) => steps.push([done, total]),
    );
    // The progress a screen shows is "how many are behind us", not "how many
    // worked" — otherwise a batch of failures looks frozen.
    expect(steps).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('awaits an async action rather than firing them all at once', async () => {
    // Deleting drains the file journal; two drains at once over one library is
    // the race the claim registry exists to prevent.
    let running = 0;
    let overlapped = false;
    await runBatch(['a', 'b', 'c'], async () => {
      running += 1;
      if (running > 1) overlapped = true;
      await Promise.resolve();
      running -= 1;
    });
    expect(overlapped).toBe(false);
  });

  it('is harmless with nothing selected', async () => {
    expect(await runBatch([], () => undefined)).toEqual({ done: 0, failures: [] });
  });
});

describe('describeBatch', () => {
  it('says the plain number when everything worked', () => {
    expect(describeBatch('删除', { done: 3, failures: [] })).toBe('已删除 3 首');
  });

  it('says both numbers and quotes one reason', () => {
    expect(describeBatch('删除', { done: 7, failures: ['忙', '忙', '忙'] })).toBe(
      '已删除 7 首，3 首没能删除：忙',
    );
  });

  it('does not claim a partial success when there was none', () => {
    expect(describeBatch('删除', { done: 0, failures: ['忙'] })).toBe('一首都没能删除：忙');
  });
});

describe('what can be done with a link', () => {
  it('opens http and https, and nothing else', () => {
    expect(openableLink(song('https://www.bilibili.com/video/BV1'))).toBe(
      'https://www.bilibili.com/video/BV1',
    );
    expect(openableLink(song('http://example.com/x'))).toBe('http://example.com/x');
    // The whole reason this file exists: these reach the system as commands.
    for (const hostile of [
      'intent://scan/#Intent;scheme=zxing;end',
      'file:///data/data/com.orpheusaviary.lark/databases/songs.db',
      'javascript:alert(1)',
      'content://media/external/audio',
      'app-scheme://open',
    ]) {
      expect(openableLink(song(hostile))).toBeNull();
    }
  });

  it('is null when there is no link at all', () => {
    expect(openableLink(song(null))).toBeNull();
    expect(openableLink(song(''))).toBeNull();
  });

  it('says WHICH of the two reasons it is, when asked', () => {
    expect(refusalFor(song(null))).toBe('这首歌没有链接');
    expect(refusalFor(song('intent://x'))).toBe('这个链接不是 http(s)，不会交给系统打开');
    expect(refusalFor(song('https://x/y'))).toBeNull();
  });

  it('copies anything that is there, because copying is not acting on it', () => {
    expect(copyableLink(song('intent://x'))).toBe('intent://x');
    expect(copyableLink(song(null))).toBeNull();
  });
});
