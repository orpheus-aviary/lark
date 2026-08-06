// The download wire contract is frozen here (T1): M4's download bar and M6's
// CLI are written against these exact shapes, so a change has to be a
// deliberate edit to this file, not a drive-by widening.
//
// Two kinds of assertion live here. The runtime ones check the constants the
// daemon validates against. The `satisfies` ones are compile-time — they fail
// `tsc -b`, not vitest — and exist to pin field names and unions that no
// runtime check can see.

import { describe, expect, it } from 'vitest';
import { API_PATHS, apiPath } from './api-paths.js';
import {
  DOWNLOAD_STAGES,
  DOWNLOAD_TASK_KINDS,
  type DownloadBatchData,
  type DownloadBatchRequest,
  type DownloadTaskData,
  type FetchListRequest,
  type LarkEvent,
  type ParsedItem,
  TASK_STATES,
} from './types.js';

describe('task lifecycle constants', () => {
  it('freezes the state domain', () => {
    expect(TASK_STATES).toEqual(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
  });

  it('freezes the stage domain', () => {
    expect(DOWNLOAD_STAGES).toEqual([
      'analyzing',
      'searching',
      'resolving',
      'downloading',
      'converting',
      'saving',
      'lyrics',
    ]);
  });

  // Queuing is a state. A `queued` stage would make the two axes overlap and
  // reintroduce the "which field do I read?" question the split exists to kill.
  it('keeps queued out of the stage domain', () => {
    expect(DOWNLOAD_STAGES).not.toContain('queued');
  });

  it('freezes the task kinds', () => {
    expect(DOWNLOAD_TASK_KINDS).toEqual(['download', 'redownload', 'ensure-file', 'lyrics']);
  });

  it('has no overlap between the two domains', () => {
    const stages = new Set<string>(DOWNLOAD_STAGES);
    expect(TASK_STATES.filter((s) => stages.has(s))).toEqual([]);
  });
});

describe('download API paths', () => {
  it('exposes every M3 endpoint', () => {
    expect(API_PATHS.downloadSong).toBe('/download/song');
    expect(API_PATHS.downloadParse).toBe('/download/parse');
    expect(API_PATHS.downloadBatch).toBe('/download/batch');
    expect(API_PATHS.downloadFetchList).toBe('/download/fetch-list');
    expect(API_PATHS.downloadCancel).toBe('/download/cancel');
    expect(API_PATHS.downloadTasks).toBe('/download/tasks');
    expect(API_PATHS.songImport).toBe('/songs/import');
    expect(apiPath.downloadLyrics('abc')).toBe('/download/lyrics/abc');
    expect(apiPath.songRecognizeUrl('abc')).toBe('/songs/abc/recognize-url');
    expect(apiPath.songRedownload('abc')).toBe('/songs/abc/redownload');
  });

  // Two names mapping to one path would make the daemon's route-coverage guard
  // (M2-13) pass while an endpoint silently shadowed another.
  it('keeps every static path distinct', () => {
    const values = Object.values(API_PATHS);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('wire shapes (compile-time)', () => {
  it('accepts a fully populated task', () => {
    const task = {
      id: 't1',
      kind: 'download',
      state: 'succeeded',
      stage: null,
      revision: 7,
      input: { type: 'url', url: 'https://www.bilibili.com/video/BV1Ki4y1y7HC' },
      song_id: 's1',
      playlist_ids: ['p1'],
      failed_playlist_ids: ['p2'],
      created_at: 1,
      started_at: 2,
      finished_at: 3,
      error_code: null,
      error_message: null,
      result: { song_id: 's1' },
    } satisfies DownloadTaskData;
    expect(task.result?.song_id).toBe('s1');
  });

  it('separates the request target from the snapshot target', () => {
    // `new` only exists on the request side: the snapshot carries the id the
    // daemon actually created, which is what M4 navigates to.
    const request = {
      groups: [
        {
          target: { kind: 'new', name: '新歌单' },
          items: [
            { kind: 'video', bvid: 'BV1Ki4y1y7HC', page: null, title: '稻香' },
            { kind: 'keyword', query: '周杰伦 稻香' },
          ],
        },
      ],
    } satisfies DownloadBatchRequest;

    const snapshot = {
      id: 'b1',
      target: { kind: 'playlist', playlist_id: 'p9', name: '新歌单' },
      total: 2,
      items: [
        { index: 0, task_id: 't1', final: null },
        {
          index: 1,
          task_id: 't2',
          final: { state: 'failed', error_code: 'LLM_FAILED', song_id: null },
        },
      ],
      created_at: 1,
    } satisfies DownloadBatchData;

    expect(request.groups[0]?.items).toHaveLength(snapshot.total);
  });

  it('covers all four parsed item kinds', () => {
    const items = [
      { kind: 'video', bvid: 'BV1Ki4y1y7HC', page: 2, url: 'https://x' },
      { kind: 'favorites', media_id: '96661672', url: 'https://x' },
      { kind: 'collection', mid: '229733301', season_id: '5981270', url: 'https://x' },
      { kind: 'keyword', query: '稻香' },
    ] satisfies ParsedItem[];
    expect(items.map((i) => i.kind)).toEqual(['video', 'favorites', 'collection', 'keyword']);
  });

  it('requires each fetch-list kind to carry its own ids', () => {
    const requests = [
      { type: 'favorites', media_id: '96661672' },
      { type: 'collection', mid: '229733301', season_id: '5981270' },
    ] satisfies FetchListRequest[];
    expect(requests).toHaveLength(2);
  });

  it('carries state/stage on download:status and a code on download:error', () => {
    const events = [
      {
        type: 'download:status',
        task_id: 't1',
        state: 'running',
        stage: 'downloading',
        revision: 4,
      },
      { type: 'download:status', task_id: 't1', state: 'queued', stage: null, revision: 1 },
      { type: 'download:complete', task_id: 't1', song_id: 's1' },
      { type: 'download:error', task_id: 't1', error_code: 'FFMPEG_FAILED', message: 'boom' },
      { type: 'download:cancelled', task_id: 't1' },
      { type: 'download:batches-changed', batch_id: 'b1' },
    ] satisfies LarkEvent[];
    expect(events).toHaveLength(6);
  });
});
