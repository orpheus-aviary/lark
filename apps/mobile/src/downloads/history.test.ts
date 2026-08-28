import type { DownloadTaskData } from '@lark/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  type DownloadRecord,
  canRetry,
  createDownloadHistory,
  planRetry,
  readRecord,
} from './history';

const task = (patch: Partial<DownloadTaskData> = {}): DownloadTaskData =>
  ({
    id: 't1',
    kind: 'download',
    state: 'succeeded',
    stage: null,
    revision: 1,
    input: { type: 'url', url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    origin: { kind: 'video', url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    song_id: 's1',
    playlist_ids: [],
    failed_playlist_ids: [],
    created_at: 1,
    started_at: 1,
    finished_at: 100,
    error_code: null,
    error_message: null,
    result: { song_id: 's1' },
    received_bytes: 0,
    total_bytes: null,
    title: '半城烟沙',
    artist: '许嵩',
    ...patch,
  }) as DownloadTaskData;

/** A history over memory, so a test can read back what was written. */
function store(initial: string | null = null, limit?: number) {
  const saved: string[] = [];
  const history = createDownloadHistory({
    load: () => initial,
    save: async (text) => {
      saved.push(text);
    },
    ...(limit === undefined ? {} : { limit }),
  });
  return { history, saved, last: () => saved.at(-1) };
}

describe('observe', () => {
  it('keeps a finished task and ignores a running one', () => {
    const { history } = store();
    history.observe([task({ id: 'a' }), task({ id: 'b', state: 'running', finished_at: null })]);
    expect(history.getRecords().map((r) => r.id)).toEqual(['a']);
  });

  it('records the same task once, however often the hub ticks', async () => {
    const { history, saved } = store();
    history.observe([task()]);
    history.observe([task()]);
    history.observe([task()]);
    await history.flush();
    expect(history.getRecords()).toHaveLength(1);
    expect(saved).toHaveLength(1);
  });

  it('picks a running task up once it finishes', () => {
    const { history } = store();
    history.observe([task({ state: 'running', finished_at: null })]);
    expect(history.getRecords()).toHaveLength(0);
    history.observe([task({ state: 'failed', error_message: '超时' })]);
    expect(history.getRecords()[0]?.state).toBe('failed');
  });

  it('does not put back what was deleted, even though the engine still holds it', () => {
    // 🔴 The reason `known` outlives the list: the engine's ring keeps a
    // terminal task for the rest of the launch, so a store that re-derived
    // from the snapshot would undo every delete on the next status event.
    const { history } = store();
    history.observe([task()]);
    history.remove('t1');
    history.observe([task()]);
    expect(history.getRecords()).toHaveLength(0);
  });

  it('does not put back what 清空 removed', () => {
    const { history } = store();
    history.observe([task({ id: 'a' }), task({ id: 'b' })]);
    history.clear();
    history.observe([task({ id: 'a' }), task({ id: 'b' })]);
    expect(history.getRecords()).toHaveLength(0);
  });

  it('drops a lyrics fetch that worked — the download it followed says it already', () => {
    // 🔴 The engine spawns one of these after EVERY successful download, and
    // they carry the song's name, so keeping them would make the record half
    // duplicates of itself — forever, in a file with 200 slots.
    const { history } = store();
    history.observe([task({ id: 'song' }), task({ id: 'words', kind: 'lyrics' })]);
    expect(history.getRecords().map((r) => r.id)).toEqual(['song']);
  });

  it('keeps a lyrics fetch that failed — nothing else in the app says so', () => {
    const { history } = store();
    history.observe([task({ id: 'words', kind: 'lyrics', state: 'failed' })]);
    expect(history.getRecords().map((r) => r.id)).toEqual(['words']);
  });

  it('keeps the newest when it is over the cap', () => {
    const { history } = store(null, 2);
    history.observe([
      task({ id: 'old', finished_at: 1 }),
      task({ id: 'new', finished_at: 3 }),
      task({ id: 'mid', finished_at: 2 }),
    ]);
    expect(history.getRecords().map((r) => r.id)).toEqual(['new', 'mid']);
  });

  it('carries what a retry needs', () => {
    const { history } = store();
    history.observe([
      task({
        state: 'failed',
        playlist_ids: ['p1'],
        input: { type: 'url', url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=3' },
        error_code: 'BILIBILI_FAILED',
        error_message: '连不上',
      }),
    ]);
    const record = history.getRecords()[0] as DownloadRecord;
    expect(record.input).toEqual({
      type: 'url',
      url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=3',
    });
    expect(record.playlist_ids).toEqual(['p1']);
    expect(record.error_code).toBe('BILIBILI_FAILED');
  });
});

describe('add', () => {
  const refusal = (id: string, at = 1): DownloadRecord =>
    ({
      id: `cache-limit:${id}`,
      kind: 'ensure-file',
      state: 'failed',
      title: id,
      artist: null,
      input: { type: 'song', song_id: id },
      playlist_ids: [],
      song_id: id,
      error_code: 'CACHE_LIMIT',
      error_message: 'no room',
      finished_at: at,
    }) as DownloadRecord;

  it('keeps rows that no task produced', () => {
    const { history } = store();
    history.add([refusal('a'), refusal('b')]);
    expect(history.getRecords()).toHaveLength(2);
  });

  it('replaces its own row rather than stacking a second one', () => {
    // Tapping 全部下载 twice is one answer about the same songs.
    const { history } = store();
    history.add([refusal('a', 1)]);
    history.add([refusal('a', 2)]);
    expect(history.getRecords()).toHaveLength(1);
    expect(history.getRecords()[0]?.finished_at).toBe(2);
  });

  it('leaves the rows it was not given alone', () => {
    const { history } = store();
    history.observe([task({ id: 'downloaded' })]);
    history.add([refusal('a')]);
    expect(
      history
        .getRecords()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['cache-limit:a', 'downloaded']);
  });
});

describe('the file', () => {
  it('survives a round trip', async () => {
    const first = store();
    first.history.observe([task({ id: 'a', finished_at: 5 })]);
    await first.history.flush();
    const reopened = store(first.last() ?? null);
    expect(reopened.history.getRecords().map((r) => r.id)).toEqual(['a']);
  });

  it('reads a missing, empty or broken file as no history, and does not write over it', async () => {
    for (const text of [null, '', '{]', '{"not":"a list"}']) {
      const { history, saved } = store(text);
      expect(history.getRecords()).toEqual([]);
      await history.flush();
      expect(saved).toEqual([]);
    }
  });

  it('skips entries it cannot read and keeps the ones it can', () => {
    const good = JSON.stringify([
      {
        id: 'ok',
        kind: 'download',
        state: 'succeeded',
        input: { type: 'song', song_id: 's' },
        finished_at: 2,
      },
      { id: 'no-input', kind: 'download', state: 'succeeded', finished_at: 3 },
      {
        id: 'bad-state',
        kind: 'download',
        state: 'running',
        input: { type: 'song', song_id: 's' },
        finished_at: 4,
      },
    ]);
    const { history } = store(good);
    expect(history.getRecords().map((r) => r.id)).toEqual(['ok']);
  });

  it('refuses an entry whose input is not one of the three', () => {
    expect(
      readRecord({
        id: 'x',
        kind: 'download',
        state: 'failed',
        input: { type: 'magic' },
        finished_at: 1,
      }),
    ).toBeNull();
  });

  // ④ — the caption survives the trip through the file, and its absence is
  // not a reason to lose the row.
  it('keeps where a download came from', () => {
    const { history } = store();
    history.observe([
      task({
        origin: {
          kind: 'list',
          list: 'collection',
          title: '华语经典',
          url: 'https://space.bilibili.com/1/lists/9',
          video_url: 'https://www.bilibili.com/video/BV3?p=2',
          index: 3,
          total: 50,
        },
      }),
    ]);
    expect(history.getRecords()[0]?.origin).toEqual({
      kind: 'list',
      list: 'collection',
      title: '华语经典',
      url: 'https://space.bilibili.com/1/lists/9',
      video_url: 'https://www.bilibili.com/video/BV3?p=2',
      index: 3,
      total: 50,
    });
  });

  // Everything written before 0.2.0. The row is what somebody downloaded;
  // dropping it over a missing caption would cost more than the caption.
  it('reads a record from before there was an origin', () => {
    const record = readRecord({
      id: 'old',
      kind: 'download',
      state: 'succeeded',
      input: { type: 'keyword', query: '稻香' },
      finished_at: 1,
    });
    expect(record?.id).toBe('old');
    expect(record?.origin).toBeUndefined();
  });

  it('drops an origin it cannot read, and keeps the record', () => {
    const record = readRecord({
      id: 'weird',
      kind: 'download',
      state: 'succeeded',
      input: { type: 'keyword', query: '稻香' },
      origin: { kind: 'list', list: 'playlist', title: 'x' },
      finished_at: 1,
    });
    expect(record?.id).toBe('weird');
    expect(record?.origin).toBeUndefined();
  });

  it('tells listeners once per change', () => {
    const { history } = store();
    const heard = vi.fn();
    const stop = history.subscribe(heard);
    history.observe([task()]);
    history.observe([task()]); // already known — nothing changed
    stop();
    history.observe([task({ id: 'b' })]);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('canRetry', () => {
  const at = (state: DownloadRecord['state']): DownloadRecord =>
    ({ id: 'r', kind: 'download', state, input: { type: 'song', song_id: 's' } }) as DownloadRecord;

  it('offers nothing on a success — the song menu already carries 重新下载', () => {
    expect(canRetry(at('succeeded'))).toBe(false);
  });

  it('offers it on the two that did not finish', () => {
    expect(canRetry(at('failed'))).toBe(true);
    expect(canRetry(at('cancelled'))).toBe(true);
  });
});

describe('planRetry', () => {
  const record = (patch: Partial<DownloadRecord>): DownloadRecord =>
    ({
      id: 'r',
      kind: 'download',
      state: 'failed',
      title: null,
      artist: null,
      input: { type: 'url', url: 'u' },
      playlist_ids: [],
      song_id: null,
      error_code: null,
      error_message: null,
      finished_at: 1,
      ...patch,
    }) as DownloadRecord;

  it('sends a link back through the add page, with its playlists', () => {
    expect(planRetry(record({ input: { type: 'url', url: 'u' }, playlist_ids: ['p'] }))).toEqual({
      kind: 'submit',
      text: 'u',
      playlistIds: ['p'],
    });
  });

  it('sends a keyword back the same way', () => {
    expect(planRetry(record({ input: { type: 'keyword', query: '半城烟沙' } }))).toEqual({
      kind: 'submit',
      text: '半城烟沙',
      playlistIds: [],
    });
  });

  it('asks the engine directly for a song it already knows', () => {
    expect(
      planRetry(record({ kind: 'ensure-file', input: { type: 'song', song_id: 's1' } })),
    ).toEqual({ kind: 'redownload', songId: 's1' });
  });

  it('sends a cache-limit refusal straight to the engine, past the gate that made it', () => {
    // 🔴 0.1.1 ⑤: the batch stopped because there is no room, and tapping 重下
    // IS the decision to go past the limit. The plan has to reach the engine
    // — anything that consulted the budget again would refuse forever.
    expect(
      planRetry(
        record({
          kind: 'ensure-file',
          state: 'failed',
          error_code: 'CACHE_LIMIT',
          input: { type: 'song', song_id: 's1' },
        }),
      ),
    ).toEqual({ kind: 'redownload', songId: 's1' });
  });

  it('tells lyrics apart from audio — they fetch different files', () => {
    expect(planRetry(record({ kind: 'lyrics', input: { type: 'song', song_id: 's1' } }))).toEqual({
      kind: 'lyrics',
      songId: 's1',
    });
  });
});
