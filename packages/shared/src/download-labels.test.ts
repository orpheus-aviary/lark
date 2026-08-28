// What lifting the tables out of the GUI was FOR (N4d, decision a).
//
// The GUI's copy had no tests, and neither did the CLI's — which is how three
// front ends ended up with three tables in the first place. The exhaustiveness
// cases below are the point: adding a stage, a state or a kind to `types.ts`
// and forgetting the wording is now a red test rather than an `undefined`
// rendered into a status line on somebody's phone.

import { describe, expect, it } from 'vitest';
import {
  KIND_LABELS,
  STAGE_LABELS,
  STATE_LABELS,
  inputLabel,
  originCopyText,
  originLabel,
  taskDescription,
  taskLabel,
  taskTitle,
} from './download-labels.js';
import {
  DOWNLOAD_STAGES,
  DOWNLOAD_TASK_KINDS,
  type DownloadTaskData,
  TASK_STATES,
} from './types.js';

function task(overrides: Partial<DownloadTaskData> = {}): DownloadTaskData {
  return {
    id: 't1',
    kind: 'download',
    state: 'running',
    stage: 'downloading',
    revision: 1,
    input: { type: 'url', url: 'https://b23.tv/abc' },
    origin: { kind: 'video', url: 'https://b23.tv/abc' },
    song_id: null,
    playlist_ids: [],
    failed_playlist_ids: [],
    created_at: 0,
    started_at: 0,
    finished_at: null,
    error_code: null,
    error_message: null,
    result: null,
    received_bytes: 0,
    total_bytes: null,
    title: null,
    artist: null,
    ...overrides,
  };
}

describe('the three tables', () => {
  it('names every stage', () => {
    for (const stage of DOWNLOAD_STAGES) expect(STAGE_LABELS[stage]).toBeTruthy();
    expect(Object.keys(STAGE_LABELS)).toHaveLength(DOWNLOAD_STAGES.length);
  });

  it('names every state', () => {
    for (const state of TASK_STATES) expect(STATE_LABELS[state]).toBeTruthy();
    expect(Object.keys(STATE_LABELS)).toHaveLength(TASK_STATES.length);
  });

  it('has an entry for every kind, and only `download` is deliberately untagged', () => {
    expect(Object.keys(KIND_LABELS)).toHaveLength(DOWNLOAD_TASK_KINDS.length);
    for (const kind of DOWNLOAD_TASK_KINDS) expect(KIND_LABELS[kind]).not.toBeUndefined();
    expect(KIND_LABELS.download).toBeNull();
  });
});

describe('inputLabel', () => {
  it('shows a url and a keyword verbatim', () => {
    expect(inputLabel({ type: 'url', url: 'https://b23.tv/x' })).toBe('https://b23.tv/x');
    expect(inputLabel({ type: 'keyword', query: '莫愁乡' })).toBe('莫愁乡');
  });

  it('has one phrase for a task that started from a song', () => {
    expect(inputLabel({ type: 'song', song_id: 's1' })).toBe('已有歌曲');
  });
});

describe('taskTitle', () => {
  it('falls back to the input rather than inventing a name', () => {
    expect(taskTitle(task({ title: null }))).toBe('https://b23.tv/abc');
  });

  it('uses the title as soon as there is one', () => {
    expect(taskTitle(task({ title: '莫愁乡' }))).toBe('莫愁乡');
  });
});

describe('taskDescription', () => {
  it('leaves a plain download untagged', () => {
    expect(taskDescription(task({ title: '莫愁乡' }))).toBe('莫愁乡');
  });

  it('tags the kinds that would otherwise read as the same row twice', () => {
    expect(taskDescription(task({ kind: 'lyrics', title: '莫愁乡' }))).toBe('歌词 莫愁乡');
  });
});

// ④ — four ways a download gets asked for, and two questions about each: what
// the row says, and what the copy button hands over.
describe('originLabel / originCopyText', () => {
  it('says the words that were typed, and copies them back', () => {
    const origin = { kind: 'keyword', query: '周杰伦 稻香' } as const;
    expect(originLabel(origin)).toBe('from：周杰伦 稻香');
    expect(originCopyText(origin)).toBe('周杰伦 稻香');
  });

  it('keeps the part number on a link, both times', () => {
    const origin = { kind: 'video', url: 'https://www.bilibili.com/video/BV1?p=2' } as const;
    expect(originLabel(origin)).toBe('from：https://www.bilibili.com/video/BV1?p=2');
    expect(originCopyText(origin)).toBe('https://www.bilibili.com/video/BV1?p=2');
  });

  // The label names the LIST; the button copies the one video. Two different
  // questions, which is why the row has one button and not two.
  it('counts an entry inside its list, and copies the entry', () => {
    const origin = {
      kind: 'list',
      list: 'collection',
      title: '华语经典',
      url: 'https://space.bilibili.com/1/lists/9',
      video_url: 'https://www.bilibili.com/video/BV3?p=2',
      index: 3,
      total: 50,
    } as const;
    expect(originLabel(origin)).toBe('from：华语经典（3/50）');
    expect(originCopyText(origin)).toBe('https://www.bilibili.com/video/BV3?p=2');
  });

  it('has a name but no link for a song that was already in the library', () => {
    const origin = { kind: 'song', song_id: 's-1' } as const;
    expect(originLabel(origin)).toBe('from：曲库里已有的歌');
    expect(originCopyText(origin)).toBe(null);
  });
});

describe('taskLabel', () => {
  it('says the state when the task is not running', () => {
    expect(taskLabel(task({ state: 'queued', stage: null }))).toBe('排队中');
    expect(taskLabel(task({ state: 'failed', stage: null }))).toBe('失败');
  });

  it('says the stage when it is', () => {
    expect(taskLabel(task({ stage: 'naming' }))).toBe('清洗命名');
  });

  it('appends progress only where progress is a question worth answering', () => {
    expect(taskLabel(task({ received_bytes: 50, total_bytes: 100 }))).toBe('下载音频 50%');
    // Every stage but `downloading`, and the moment before the first chunk.
    expect(taskLabel(task({ stage: 'saving', received_bytes: 50, total_bytes: 100 }))).toBe('落盘');
    expect(taskLabel(task({ received_bytes: 0, total_bytes: 100 }))).toBe('下载音频');
  });

  it('counts megabytes when the source never said how big it was', () => {
    // "3.4MB of ?" is still progress; "NaN%" is not.
    expect(taskLabel(task({ received_bytes: 3_565_158, total_bytes: null }))).toBe(
      '下载音频 3.4MB',
    );
  });

  it('ignores a stage on a task the engine has already finished', () => {
    expect(taskLabel(task({ state: 'succeeded', stage: 'lyrics' }))).toBe('已完成');
  });
});
