// The download routes, against the fake upstream. What is worth asserting at
// this layer is the CONTRACT — which failures are synchronous, which are
// asynchronous, what a guardrail rejects, and which events reach the bus —
// not the pipeline behaviour, which engine.test.ts already covers.

import { type FakeUpstream, startFakeUpstream } from '@lark/core/testing';
import { API_PATHS, type LarkEvent, apiPath } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type TestApp,
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';

const BVID = 'BV1Ki4y1y7HC';
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}`;

let ctx: TestContext;
let app: TestApp;
let upstream: FakeUpstream;
let events: LarkEvent[];

beforeEach(async () => {
  upstream = await startFakeUpstream();
  ctx = createTestContext({ bilibiliBase: upstream.baseUrl });
  app = buildTestServer(ctx);
  events = [];
  ctx.eventsBus.subscribe((event) => events.push(event));
});

afterEach(async () => {
  await app.close();
  await closeTestContext(ctx);
  await upstream.close();
});

const configureLlm = () => {
  ctx.config.llm = {
    url: upstream.llmUrl(),
    model: 'fake',
    api_key: 'k',
    api_format: 'openai',
  };
};

/**
 * `app.inject` returns an intersection that includes `void` (its
 * callback overload), which `await` does not narrow through a helper. The
 * explicit return type is what keeps every call site typed.
 */
const post = async (
  url: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: string }> => {
  const res = await app.inject({ method: 'POST', url, payload });
  return { statusCode: res.statusCode, body: res.body };
};

const bodyOf = (res: { body: string }) => JSON.parse(res.body);

// ─── POST /download/song ───────────────────────────────

describe('POST /download/song', () => {
  it('queues a single-part URL with no LLM configured', async () => {
    const res = await post(API_PATHS.downloadSong, { input: VIDEO_URL, naming_mode: 'original' });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).data.task_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // The preflight's whole point: an answer the user can act on, before the
  // queue, rather than a task that fails minutes later.
  it('refuses a multi-part video with no ?p=, and says how to fix it', async () => {
    upstream.state.videos.set(BVID, {
      title: '多P',
      owner: 'UP',
      ownerMid: 1,
      duration: 10,
      pages: [
        { page: 1, part: '一', duration: 5, cid: 111 },
        { page: 2, part: '二', duration: 5, cid: 222 },
      ],
    });
    const res = await post(API_PATHS.downloadSong, { input: VIDEO_URL, naming_mode: 'original' });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error_code).toBe('MULTI_PART_UNRESOLVED');
    expect(bodyOf(res).message).toContain('?p=');
    expect(ctx.downloads.snapshot().tasks).toEqual([]);
  });

  // 🔴 INVERTED IN 0.5.1 (§7.3-e). It used to assert that configuring a model
  // made this video acceptable, because the model then picked a part — and
  // answered "1" whenever it could not tell, which is a different song and no
  // way to notice. A model answers nothing here now; a person says which part.
  it('still refuses it once an LLM is configured — a model does not answer this', async () => {
    upstream.state.videos.set(BVID, {
      title: '多P',
      owner: 'UP',
      ownerMid: 1,
      duration: 10,
      pages: [
        { page: 1, part: '一', duration: 5, cid: 111 },
        { page: 2, part: '二', duration: 5, cid: 222 },
      ],
    });
    configureLlm();
    const res = await post(API_PATHS.downloadSong, { input: VIDEO_URL, naming_mode: 'original' });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error_code).toBe('MULTI_PART_UNRESOLVED');
    expect(ctx.downloads.snapshot().tasks).toEqual([]);
  });

  // The other half, unchanged and now carrying more weight: naming the part is
  // the whole of what this needs, and it costs no packet at all.
  it('queues it the moment the link names a part', async () => {
    upstream.state.videos.set(BVID, {
      title: '多P',
      owner: 'UP',
      ownerMid: 1,
      duration: 10,
      pages: [
        { page: 1, part: '一', duration: 5, cid: 111 },
        { page: 2, part: '二', duration: 5, cid: 222 },
      ],
    });
    const res = await post(API_PATHS.downloadSong, {
      input: `${VIDEO_URL}?p=2`,
      naming_mode: 'original',
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not preflight at all when ?p= is explicit', async () => {
    const before = upstream.requests.length;
    await post(API_PATHS.downloadSong, { input: `${VIDEO_URL}?p=2`, naming_mode: 'original' });
    expect(upstream.requests.slice(before)).toEqual([]);
  });

  it('refuses a keyword with no LLM', async () => {
    const res = await post(API_PATHS.downloadSong, { input: '周杰伦 稻香' });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error_code).toBe('LLM_NOT_CONFIGURED');
  });

  it('refuses a non-bilibili link', async () => {
    const res = await post(API_PATHS.downloadSong, {
      input: 'https://youtube.com/watch?v=x',
      naming_mode: 'original',
    });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).message).toContain('不是 B 站链接');
  });

  it('points a list link at fetch-list instead of queuing it', async () => {
    const res = await post(API_PATHS.downloadSong, {
      input: 'https://space.bilibili.com/9666167/favlist?fid=96661672',
      naming_mode: 'original',
    });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).message).toContain('fetch-list');
  });

  // ── short links (§1.2) ──
  //
  // No production test exercised the short-link path: the client fetches the
  // literal b23.tv URL, which would hit the real host, so the one hop is driven
  // by hand here. These CHARACTERIZE the 400 the daemon has always answered, so
  // the preflight extraction (which routed this through portable's resolveInput
  // — a function that used to answer 502 NORMALIZE_FAILED) cannot quietly
  // change it.
  it('queues a short link that expands to a video', async () => {
    ctx.bilibili.expandShortLink = async () => `${VIDEO_URL}?p=1`;
    const res = await post(API_PATHS.downloadSong, {
      input: 'https://b23.tv/abc123',
      naming_mode: 'original',
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a short link that expands to another short link (400 INVALID_SOURCE)', async () => {
    ctx.bilibili.expandShortLink = async () => 'https://b23.tv/again';
    const res = await post(API_PATHS.downloadSong, {
      input: 'https://b23.tv/abc123',
      naming_mode: 'original',
    });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error_code).toBe('INVALID_SOURCE');
    expect(ctx.downloads.snapshot().tasks).toEqual([]);
  });

  it('refuses a short link that lands off bilibili (400 INVALID_SOURCE)', async () => {
    ctx.bilibili.expandShortLink = async () => 'https://youtube.com/watch?v=x';
    const res = await post(API_PATHS.downloadSong, {
      input: 'https://b23.tv/abc123',
      naming_mode: 'original',
    });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error_code).toBe('INVALID_SOURCE');
  });

  it('rejects an unknown body field', async () => {
    const res = await post(API_PATHS.downloadSong, { input: VIDEO_URL, playlist: 'x' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an oversized input', async () => {
    const res = await post(API_PATHS.downloadSong, {
      input: 'x'.repeat(9000),
      naming_mode: 'original',
    });
    expect(res.statusCode).toBe(400);
  });

  it('emits a queued status event immediately', async () => {
    await post(API_PATHS.downloadSong, { input: VIDEO_URL, naming_mode: 'original' });
    expect(events.some((e) => e.type === 'download:status' && e.state === 'queued')).toBe(true);
  });

  // ── naming_mode (0.3.0 §3.6-1) ──

  it('refuses a video link with no naming_mode', async () => {
    const res = await post(API_PATHS.downloadSong, { input: VIDEO_URL });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error_code).toBe('INVALID_BODY');
    expect(bodyOf(res).message).toContain('naming_mode');
    expect(ctx.downloads.snapshot().tasks).toEqual([]);
  });

  // The other half of "conditionally required": a keyword has no title to
  // keep, so a caller that names one is wrong about what it is asking for.
  it('refuses naming_mode on a keyword', async () => {
    configureLlm();
    const res = await post(API_PATHS.downloadSong, {
      input: '周杰伦 稻香',
      naming_mode: 'clean',
    });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error_code).toBe('INVALID_BODY');
  });

  it('refuses a value outside the two modes', async () => {
    const res = await post(API_PATHS.downloadSong, { input: VIDEO_URL, naming_mode: 'fancy' });
    expect(res.statusCode).toBe(400);
  });

  // Criterion 28, the daemon half: cleaning is an LLM call, so a machine
  // without one hears it before the queue rather than one failed task later.
  it('refuses clean naming with no LLM, and takes original', async () => {
    const refused = await post(API_PATHS.downloadSong, {
      input: VIDEO_URL,
      naming_mode: 'clean',
    });
    expect(refused.statusCode).toBe(400);
    expect(bodyOf(refused).error_code).toBe('LLM_NOT_CONFIGURED');

    const accepted = await post(API_PATHS.downloadSong, {
      input: VIDEO_URL,
      naming_mode: 'original',
    });
    expect(accepted.statusCode).toBe(200);
  });

  // Criterion 26 on the single-input channel: the two would merge onto one
  // task, and the second submitter would silently get the first one's answer.
  it('refuses a second submission under the other mode', async () => {
    configureLlm();
    expect(
      (await post(API_PATHS.downloadSong, { input: `${VIDEO_URL}?p=1`, naming_mode: 'original' }))
        .statusCode,
    ).toBe(200);

    const res = await post(API_PATHS.downloadSong, {
      input: `${VIDEO_URL}?p=1`,
      naming_mode: 'clean',
    });
    expect(res.statusCode).toBe(409);
    expect(bodyOf(res).error_code).toBe('NAMING_MODE_CONFLICT');
    expect(ctx.downloads.snapshot().tasks).toHaveLength(1);
  });

  // `(state, stage)` is not unique — binding the song id keeps the stage at
  // `resolving` — so the revision is what makes the dedupe key work.
  it('carries the revision on every status event', async () => {
    await post(API_PATHS.downloadSong, { input: VIDEO_URL, naming_mode: 'original' });
    const statuses = events.filter((e) => e.type === 'download:status');
    expect(statuses.length).toBeGreaterThan(0);
    for (const event of statuses) expect(event.revision).toBeGreaterThan(0);
  });
});

// ─── POST /download/parse ──────────────────────────────

describe('POST /download/parse', () => {
  it('classifies every line and queues nothing', async () => {
    const res = await post(API_PATHS.downloadParse, {
      input: [
        VIDEO_URL,
        'https://space.bilibili.com/9666167/favlist?fid=96661672',
        'https://space.bilibili.com/229733301/lists/5981270',
        '周杰伦 稻香',
      ].join('\n'),
    });

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).data.items.map((i: { kind: string }) => i.kind)).toEqual([
      'video',
      'favorites',
      'collection',
      'keyword',
    ]);
    expect(ctx.downloads.snapshot().tasks).toEqual([]);
  });

  it('rejects more lines than the guardrail allows', async () => {
    const res = await post(API_PATHS.downloadParse, {
      input: Array.from({ length: 201 }, () => 'x').join('\n'),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── /download/history ─────────────────────────────────

describe('/download/history', () => {
  const del = async (url: string): Promise<{ statusCode: number; body: string }> => {
    const res = await app.inject({ method: 'DELETE', url });
    return { statusCode: res.statusCode, body: res.body };
  };
  const get = async (url: string): Promise<{ statusCode: number; body: string }> => {
    const res = await app.inject({ method: 'GET', url });
    return { statusCode: res.statusCode, body: res.body };
  };

  /** Queue one download and wait for it to reach the record. */
  const finishOne = async (): Promise<string> => {
    const res = await post(API_PATHS.downloadSong, { input: VIDEO_URL, naming_mode: 'original' });
    const taskId = bodyOf(res).data.task_id as string;
    await vi.waitFor(() => {
      expect(ctx.downloadHistory.getRecords().map((r) => r.id)).toContain(taskId);
    });
    return taskId;
  };

  it('answers with what has already finished', async () => {
    const taskId = await finishOne();
    const res = await get(API_PATHS.downloadHistory);

    expect(res.statusCode).toBe(200);
    const records = bodyOf(res).data.records as { id: string; state: string }[];
    expect(records.map((r) => r.id)).toContain(taskId);
  });

  it('clears the lot', async () => {
    await finishOne();
    const res = await del(API_PATHS.downloadHistory);

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).data.records).toEqual([]);
    expect(bodyOf(await get(API_PATHS.downloadHistory)).data.records).toEqual([]);
  });

  // 🔴 THE RULE THIS ENDPOINT EXISTS TO KEEP. The engine's ring is still
  // holding that task for the rest of the launch, so a store that re-derived
  // its rows from a snapshot would put the deleted one straight back on the
  // next status event — and on a phone that reads as "the row came back and I
  // do not know why".
  it('does not put a deleted row back on the next status event', async () => {
    const taskId = await finishOne();
    const res = await del(apiPath.downloadHistoryItem(taskId));
    expect(res.statusCode).toBe(200);
    expect((bodyOf(res).data.records as { id: string }[]).map((r) => r.id)).not.toContain(taskId);

    // The same task, reported again exactly as the engine would.
    const snapshot = ctx.downloads.snapshot().tasks.find((task) => task.id === taskId);
    expect(snapshot).toBeDefined();
    ctx.downloadHistory.observe([snapshot as NonNullable<typeof snapshot>]);

    const after = bodyOf(await get(API_PATHS.downloadHistory)).data.records as { id: string }[];
    expect(after.map((r) => r.id)).not.toContain(taskId);
  });

  it('reads a record written by an earlier launch', async () => {
    await app.close();
    await closeTestContext(ctx);
    ctx = createTestContext({
      bilibiliBase: upstream.baseUrl,
      downloadHistory: JSON.stringify([
        {
          id: '11111111-1111-4111-8111-111111111111',
          kind: 'download',
          state: 'failed',
          title: '上一次启动',
          artist: null,
          input: { type: 'keyword', query: '稻香' },
          playlist_ids: [],
          song_id: null,
          error_code: 'X',
          error_message: 'x',
          finished_at: 1,
        },
      ]),
    });
    app = buildTestServer(ctx);

    const records = bodyOf(await get(API_PATHS.downloadHistory)).data.records as {
      title: string;
    }[];
    expect(records.map((r) => r.title)).toEqual(['上一次启动']);
  });
});

// ─── POST /download/batch ──────────────────────────────

describe('POST /download/batch', () => {
  const videoItem = (page: number | null) => ({
    kind: 'video',
    bvid: BVID,
    page,
    title: null,
    naming: 'original' as const,
  });

  it('creates the new playlist, returns full snapshots and announces both', async () => {
    const res = await post(API_PATHS.downloadBatch, {
      groups: [{ target: { kind: 'new', name: '导入' }, items: [videoItem(1)] }],
    });

    expect(res.statusCode).toBe(200);
    const [batch] = bodyOf(res).data.batches;
    expect(batch.target).toMatchObject({ kind: 'playlist', name: '导入' });
    expect(batch.target.playlist_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(batch.items[0]).toMatchObject({ index: 0, final: null });

    expect(events.some((e) => e.type === 'playlists:changed')).toBe(true);
    expect(events.some((e) => e.type === 'download:batches-changed')).toBe(true);
  });

  // Without this the batch would be invisible: every item merged onto an
  // existing pending task, so no task transition happens at all.
  it('announces a batch whose items all merged onto pending tasks', async () => {
    await post(API_PATHS.downloadSong, { input: `${VIDEO_URL}?p=1`, naming_mode: 'original' });
    events.length = 0;
    await post(API_PATHS.downloadBatch, {
      groups: [{ target: { kind: 'all' }, items: [videoItem(1)] }],
    });
    expect(events.filter((e) => e.type === 'download:batches-changed')).toHaveLength(1);
  });

  // ④ — the list a group came from. Absent is legal (every client sends
  // groups of pasted links), present-but-wrong is a 400 like any other body.
  it('carries the list a group was picked out of', async () => {
    const res = await post(API_PATHS.downloadBatch, {
      groups: [
        {
          target: { kind: 'all' },
          source: {
            list: 'collection',
            title: '华语经典',
            url: 'https://space.bilibili.com/1/lists/9',
          },
          items: [videoItem(2)],
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(ctx.downloads.snapshot().tasks[0]?.origin).toEqual({
      kind: 'list',
      list: 'collection',
      title: '华语经典',
      url: 'https://space.bilibili.com/1/lists/9',
      video_url: `${VIDEO_URL}?p=2`,
      index: 1,
      total: 1,
    });
  });

  it('takes a group with no source at all', async () => {
    const res = await post(API_PATHS.downloadBatch, {
      groups: [{ target: { kind: 'all' }, items: [videoItem(1)] }],
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a source that is not one of the two kinds of list', async () => {
    const res = await post(API_PATHS.downloadBatch, {
      groups: [
        {
          target: { kind: 'all' },
          source: { list: 'playlist', title: 'x', url: 'https://x' },
          items: [videoItem(1)],
        },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).message).toContain('source.list');
  });

  it('refuses a source carrying a field nobody reads', async () => {
    const res = await post(API_PATHS.downloadBatch, {
      groups: [
        {
          target: { kind: 'all' },
          source: {
            list: 'favorites',
            title: 'x',
            url: 'https://x',
            media_id: '1',
          },
          items: [videoItem(1)],
        },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).message).toContain('media_id');
  });

  it('refuses a keyword item with no LLM — no network needed to know', async () => {
    const before = upstream.requests.length;
    const res = await post(API_PATHS.downloadBatch, {
      groups: [{ target: { kind: 'all' }, items: [{ kind: 'keyword', query: '稻香' }] }],
    });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error_code).toBe('LLM_NOT_CONFIGURED');
    expect(upstream.requests.slice(before)).toEqual([]);
  });

  it('accepts a keyword item once an LLM is configured', async () => {
    configureLlm();
    const res = await post(API_PATHS.downloadBatch, {
      groups: [{ target: { kind: 'all' }, items: [{ kind: 'keyword', query: '稻香' }] }],
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a video item with no naming', async () => {
    const res = await post(API_PATHS.downloadBatch, {
      groups: [
        { target: { kind: 'all' }, items: [{ kind: 'video', bvid: BVID, page: 1, title: null }] },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).message).toContain('naming');
  });

  it('refuses naming on a keyword item', async () => {
    configureLlm();
    const res = await post(API_PATHS.downloadBatch, {
      groups: [
        {
          target: { kind: 'all' },
          items: [{ kind: 'keyword', query: '稻香', naming: 'clean' }],
        },
      ],
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a clean item with no LLM — no network needed to know either', async () => {
    const before = upstream.requests.length;
    const res = await post(API_PATHS.downloadBatch, {
      groups: [
        {
          target: { kind: 'new', name: '不该被建出来的' },
          items: [{ kind: 'video', bvid: BVID, page: 1, title: null, naming: 'clean' }],
        },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error_code).toBe('LLM_NOT_CONFIGURED');
    expect(upstream.requests.slice(before)).toEqual([]);
  });

  // Criterion 26: the refusal has to land before the playlist transaction, or
  // "every group commits or none does" is not a property of a batch.
  it('refuses a mode conflict before creating the group playlist', async () => {
    configureLlm();
    await post(API_PATHS.downloadSong, { input: `${VIDEO_URL}?p=1`, naming_mode: 'original' });

    const res = await post(API_PATHS.downloadBatch, {
      groups: [
        {
          target: { kind: 'new', name: '不该被建出来的歌单' },
          items: [{ kind: 'video', bvid: BVID, page: 1, title: null, naming: 'clean' }],
        },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect(bodyOf(res).error_code).toBe('NAMING_MODE_CONFLICT');

    const playlists = await app.inject({ method: 'GET', url: API_PATHS.playlists });
    expect(
      (playlists.json().data as { name: string }[]).some((p) => p.name === '不该被建出来的歌单'),
    ).toBe(false);
  });

  it('404s an unknown playlist target without creating anything', async () => {
    const res = await post(API_PATHS.downloadBatch, {
      groups: [
        {
          target: { kind: 'playlist', playlist_id: '11111111-2222-4333-8444-555555555555' },
          items: [videoItem(1)],
        },
      ],
    });
    expect(res.statusCode).toBe(404);
    expect(ctx.downloads.snapshot().tasks).toEqual([]);
  });

  it('rejects a malformed bvid through the same parser the paste box uses', async () => {
    const res = await post(API_PATHS.downloadBatch, {
      groups: [
        {
          target: { kind: 'all' },
          items: [{ kind: 'video', bvid: 'nope', page: 1, title: null, naming: 'original' }],
        },
      ],
    });
    expect(res.statusCode).toBe(400);
  });

  it('enforces the group and item guardrails', async () => {
    const many = { target: { kind: 'all' }, items: [videoItem(1)] };
    const tooManyGroups = await post(API_PATHS.downloadBatch, {
      groups: Array.from({ length: 21 }, () => many),
    });
    expect(tooManyGroups.statusCode).toBe(400);

    const tooManyItems = await post(API_PATHS.downloadBatch, {
      groups: [
        {
          target: { kind: 'all' },
          items: Array.from({ length: 1001 }, (_, i) => videoItem((i % 900) + 1)),
        },
      ],
    });
    expect(tooManyItems.statusCode).toBe(400);
  });
});

// ─── POST /download/fetch-list ─────────────────────────

describe('POST /download/fetch-list', () => {
  it('walks a favourites folder to the end of has_more', async () => {
    upstream.state.favorites = {
      title: '默认收藏夹',
      pages: [
        [{ bvid: BVID, title: '一', duration: 100 }],
        [{ bvid: 'BV1bt89zZE8R', title: '二', duration: 200 }],
      ],
    };
    const res = await post(API_PATHS.downloadFetchList, {
      type: 'favorites',
      media_id: '96661672',
    });

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).data.title).toBe('默认收藏夹');
    expect(bodyOf(res).data.videos).toHaveLength(2);
    expect(bodyOf(res).data.error).toBeNull();
  });

  it('reads a collection', async () => {
    const res = await post(API_PATHS.downloadFetchList, {
      type: 'collection',
      mid: '229733301',
      season_id: '5981270',
    });
    expect(bodyOf(res).data.videos).toHaveLength(1);
  });

  // The discriminated union is the contract (fifth review ⑦): each kind needs
  // its own ids, and a missing one is a 400 rather than a confusing upstream
  // error.
  it('requires each kind to carry its own ids', async () => {
    expect((await post(API_PATHS.downloadFetchList, { type: 'favorites' })).statusCode).toBe(400);
    expect(
      (await post(API_PATHS.downloadFetchList, { type: 'collection', mid: '1' })).statusCode,
    ).toBe(400);
    expect((await post(API_PATHS.downloadFetchList, { type: 'uploader' })).statusCode).toBe(400);
  });

  // Found in acceptance: a 953-item folder came back as 903 videos with
  // `error: null`, which a caller cannot tell apart from a complete list.
  it('reports truncation when a guardrail stops the walk', async () => {
    // Every page says there is more, forever — the page cap has to stop it.
    upstream.state.favorites = {
      title: '很长的收藏夹',
      pages: Array.from({ length: 210 }, (_, page) => [
        { bvid: BVID, title: `第 ${page + 1} 页`, duration: 100 },
      ]),
    };
    const res = await post(API_PATHS.downloadFetchList, {
      type: 'favorites',
      media_id: '96661672',
    });

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).data.videos).toHaveLength(200); // the page cap
    expect(bodyOf(res).data.error).toMatch(/只取回了前 200 条/);
  });

  it('leaves error null when the list simply ended', async () => {
    const res = await post(API_PATHS.downloadFetchList, {
      type: 'favorites',
      media_id: '96661672',
    });
    expect(bodyOf(res).data.error).toBeNull();
  });

  it('returns what it managed to fetch when a later page fails', async () => {
    upstream.state.favorites = {
      title: '半成功',
      pages: [[{ bvid: BVID, title: '一', duration: 100 }]],
    };
    // Page 1 says there is more, page 2 does not exist in the fixture.
    upstream.state.favorites.pages.push([]);
    const res = await post(API_PATHS.downloadFetchList, {
      type: 'favorites',
      media_id: '96661672',
    });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).data.videos).toHaveLength(1);
  });
});

// ─── cancel / tasks ────────────────────────────────────

describe('POST /download/cancel', () => {
  it('cancels a queued task', async () => {
    upstream.state.hangAudio = true;
    const first = bodyOf(
      await post(API_PATHS.downloadSong, { input: `${VIDEO_URL}?p=1`, naming_mode: 'original' }),
    );
    const second = bodyOf(
      await post(API_PATHS.downloadSong, { input: `${VIDEO_URL}?p=2`, naming_mode: 'original' }),
    );

    const res = await post(API_PATHS.downloadCancel, { task_id: second.data.task_id });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).data.state).toBe('cancelled');
    expect(events.some((e) => e.type === 'download:cancelled')).toBe(true);

    await post(API_PATHS.downloadCancel, { task_id: first.data.task_id });
  });

  it('404s an unknown task', async () => {
    const res = await post(API_PATHS.downloadCancel, {
      task_id: '11111111-2222-4333-8444-555555555555',
    });
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res).error_code).toBe('TASK_NOT_FOUND');
  });

  it('rejects a non-uuid task id', async () => {
    expect((await post(API_PATHS.downloadCancel, { task_id: 'x' })).statusCode).toBe(400);
  });
});

describe('POST /download/cancel-all', () => {
  it('answers one entry per active task, and stops them', async () => {
    upstream.state.hangAudio = true;
    await post(API_PATHS.downloadSong, { input: `${VIDEO_URL}?p=1`, naming_mode: 'original' });
    await post(API_PATHS.downloadSong, { input: `${VIDEO_URL}?p=2`, naming_mode: 'original' });

    const res = await post(API_PATHS.downloadCancelAll, {});
    expect(res.statusCode).toBe(200);
    const data = bodyOf(res).data;
    expect(data.results).toHaveLength(2);
    for (const entry of data.results) expect(entry.error_code).toBeNull();

    // A queued task stops on the spot; a running one is asked to and settles
    // on its own — so the snapshot is what proves it, not the answer.
    await vi.waitFor(() => {
      const active = ctx.downloads
        .snapshot()
        .tasks.filter((task) => task.state === 'queued' || task.state === 'running');
      expect(active).toEqual([]);
    });
  });

  it('answers an empty set when nothing is running', async () => {
    const res = await post(API_PATHS.downloadCancelAll, {});
    expect(bodyOf(res).data).toEqual({ cancelled: 0, results: [] });
  });

  it('leaves the terminal ones alone', async () => {
    upstream.state.hangAudio = true;
    await post(API_PATHS.downloadSong, { input: `${VIDEO_URL}?p=1`, naming_mode: 'original' });
    await post(API_PATHS.downloadCancelAll, {});
    await vi.waitFor(() => {
      expect(ctx.downloads.snapshot().tasks.every((task) => task.state === 'cancelled')).toBe(true);
    });

    // The second sweep has nothing to do: cancelled is not active.
    expect(bodyOf(await post(API_PATHS.downloadCancelAll, {})).data.results).toEqual([]);
  });
});

describe('GET /download/tasks', () => {
  it('answers a snapshot of tasks and batches', async () => {
    upstream.state.hangAudio = true;
    await post(API_PATHS.downloadSong, { input: `${VIDEO_URL}?p=1`, naming_mode: 'original' });
    await post(API_PATHS.downloadBatch, {
      groups: [
        {
          target: { kind: 'all' },
          items: [{ kind: 'video', bvid: BVID, page: 2, title: null, naming: 'original' }],
        },
      ],
    });

    const res = await app.inject({ method: 'GET', url: API_PATHS.downloadTasks });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).data.tasks.length).toBeGreaterThanOrEqual(2);
    expect(bodyOf(res).data.batches).toHaveLength(1);

    for (const task of ctx.downloads.snapshot().tasks) ctx.downloads.cancel(task.id);
  });

  it('is empty on a fresh daemon', async () => {
    const res = await app.inject({ method: 'GET', url: API_PATHS.downloadTasks });
    expect(bodyOf(res).data).toEqual({ tasks: [], batches: [] });
  });
});

// ─── Shutdown ──────────────────────────────────────────

describe('shutdownSignal', () => {
  // The failure this prevents: a handler parked on a bilibili call keeps
  // `server.close()` waiting, so Ctrl-C hangs for as long as the longest
  // timeout in the matrix (M3-13).
  it('cuts off a handler parked on a preflight call', async () => {
    upstream.state.videos.set(BVID, {
      title: '多P',
      owner: 'UP',
      ownerMid: 1,
      duration: 10,
      pages: [
        { page: 1, part: '一', duration: 5, cid: 111 },
        { page: 2, part: '二', duration: 5, cid: 222 },
      ],
    });
    // Longer than any test would wait for, so only the abort can end this.
    upstream.state.delayMs = 60_000;

    const started = Date.now();
    const pending = post(API_PATHS.downloadSong, { input: VIDEO_URL, naming_mode: 'original' });
    // Give the handler a moment to actually be in the fetch.
    await new Promise((r) => setTimeout(r, 50));
    ctx.shutdownController.abort(new Error('daemon shutting down'));

    const res = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    upstream.state.delayMs = 0;
  }, 30_000);
});

// ─── POST /download/lyrics/:id ─────────────────────────

describe('POST /download/lyrics/:id', () => {
  it('queues a lyrics task', async () => {
    const song = bodyOf(
      await post(API_PATHS.playlists, { name: 'x' }), // any write to prove the app works
    );
    expect(song.success).toBe(true);

    const id = '9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001';
    const res = await post(apiPath.downloadLyrics(id), {});
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).data.task_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects a non-uuid id before touching anything', async () => {
    expect((await post(apiPath.downloadLyrics('not-a-uuid'), {})).statusCode).toBe(400);
  });

  // A traversal never reaches the handler at all: the router normalises the
  // path first, so it resolves to an unregistered route.
  it('answers 404 for a traversal rather than routing it', async () => {
    expect((await post(apiPath.downloadLyrics('../etc'), {})).statusCode).toBe(404);
  });
});
