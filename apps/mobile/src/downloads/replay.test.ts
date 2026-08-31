import type { RetryPlan } from '@lark/core/portable';
import { describe, expect, it, vi } from 'vitest';
import type { Recognition } from './preflight';
import { type ReplayDeps, replay, summariseReplays, supersededRecord } from './replay';

const video = {
  kind: 'video',
  bvid: 'BV1xx411c7mD',
  page: null,
  url: 'https://www.bilibili.com/video/BV1xx411c7mD',
} as const;

function deps(recognised: Recognition, overrides: Partial<ReplayDeps> = {}): ReplayDeps {
  return {
    recognise: vi.fn(async () => recognised),
    submit: vi.fn(async () => 'new-task'),
    redownload: vi.fn(() => 'new-task'),
    lyrics: vi.fn(() => 'new-task'),
    ...overrides,
  };
}

const submitPlan: RetryPlan = { kind: 'submit', text: 'https://b23.tv/x', playlistIds: ['p1'] };

describe('replay', () => {
  it('hands back the task id, which is what bounds an automatic retry', async () => {
    // 🔴 Counting attempts by anything derived — the url, the input — lets a
    // value that normalises differently reset the count. That is not "one
    // extra try", it is a loop.
    const d = deps({ kind: 'video', item: video, extracted: false, expandedFrom: null });
    expect((await replay(d, submitPlan)).taskId).toBe('new-task');
  });

  it('sends a recognised link back through the add page, with its playlists', async () => {
    const d = deps({ kind: 'video', item: video, extracted: false, expandedFrom: null });
    expect(await replay(d, submitPlan)).toEqual({
      queued: true,
      message: '已重新排队',
      taskId: 'new-task',
    });
    expect(d.submit).toHaveBeenCalledWith(video, ['p1']);
  });

  it('asks the engine directly for a song, without a round trip', async () => {
    const d = deps({ kind: 'empty' });
    expect((await replay(d, { kind: 'redownload', songId: 's1' })).queued).toBe(true);
    expect(d.redownload).toHaveBeenCalledWith('s1');
    expect(d.recognise).not.toHaveBeenCalled();
  });

  it('tells lyrics apart — they fetch a different file', async () => {
    const d = deps({ kind: 'empty' });
    await replay(d, { kind: 'lyrics', songId: 's1' });
    expect(d.lyrics).toHaveBeenCalledWith('s1');
    expect(d.redownload).not.toHaveBeenCalled();
  });

  it('speaks for every answer the recogniser has, not just the download', async () => {
    // 🔴 The reason this file exists: three of the five answers are not
    // downloads, and a tap that silently did nothing is a tap somebody repeats.
    const refusal = await replay(
      deps({ kind: 'refused', message: '这不是一个 B 站链接' }),
      submitPlan,
    );
    expect(refusal).toEqual({ queued: false, message: '这不是一个 B 站链接', taskId: null });

    const list = await replay(
      deps({
        kind: 'list',
        item: { kind: 'favorites', id: '1', title: null },
      } as unknown as Recognition),
      submitPlan,
    );
    expect(list.queued).toBe(false);
    expect(list.message).toContain('添加');

    expect((await replay(deps({ kind: 'empty' }), submitPlan)).queued).toBe(false);
  });

  it('answers with the failure rather than throwing at the screen', async () => {
    const d = deps(
      { kind: 'video', item: video, extracted: false, expandedFrom: null },
      {
        submit: vi.fn(async () => {
          throw new Error('下载队列满了');
        }),
      },
    );
    expect(await replay(d, submitPlan)).toEqual({
      queued: false,
      message: '下载队列满了',
      taskId: null,
    });
  });
});

describe('summariseReplays', () => {
  const ok = { queued: true, message: '已重新排队', taskId: 't' };
  const no = (message: string) => ({ queued: false, message, taskId: null });

  it('counts what went back on the queue', () => {
    expect(summariseReplays([ok, ok])).toBe('已重新排队 2 条');
  });

  it('quotes one reason when none did', () => {
    expect(summariseReplays([no('队列满了'), no('别的')])).toBe('一条都没能重新排队：队列满了');
  });

  it('says both halves when some did and some did not', () => {
    expect(summariseReplays([ok, no('队列满了')])).toBe('已重新排队 1 条，1 条没能排上：队列满了');
  });
});

// ── 0.5.1 · one row per chain ────────────────────────────
//
// A record is keyed by its task id, so a retry always ADDS a row. Whether the
// old one goes is this predicate, and it had to become one because the rule
// existed in two places and the path a person taps had neither.
describe('supersededRecord', () => {
  it('is true only once the new task exists', () => {
    expect(supersededRecord({ queued: true, message: '已重新排队', taskId: 't2' })).toBe(true);
  });

  // 🔴 The half that matters more. A replay that did not get back on the queue
  // must leave the row exactly as it was — a failed row with a 重下 on it. The
  // opposite is a song that vanishes from the record and never comes back.
  it('is false when nothing was queued', () => {
    expect(supersededRecord({ queued: false, message: '这是收藏夹或合集', taskId: null })).toBe(
      false,
    );
  });

  // `queued` and `taskId` are two facts and both are required: a runtime that
  // reported success without naming the task would leave the chain unfollowable.
  it('is false when it says queued but names no task', () => {
    expect(supersededRecord({ queued: true, message: '已重新排队', taskId: null })).toBe(false);
  });
});
