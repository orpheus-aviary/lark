// The download routes, against the fake upstream. What is worth asserting at
// this layer is the CONTRACT — which failures are synchronous, which are
// asynchronous, what a guardrail rejects, and which events reach the bus —
// not the pipeline behaviour, which engine.test.ts already covers.

import { type FakeUpstream, startFakeUpstream } from '@lark/core/testing';
import { API_PATHS, type LarkEvent, apiPath } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    const res = await post(API_PATHS.downloadSong, { input: VIDEO_URL });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).data.task_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // The preflight's whole point: an answer the user can act on, before the
  // queue, rather than a task that fails minutes later.
  it('refuses a multi-part video with no ?p= and no LLM, and says how to fix it', async () => {
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
    const res = await post(API_PATHS.downloadSong, { input: VIDEO_URL });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error_code).toBe('LLM_NOT_CONFIGURED');
    expect(bodyOf(res).message).toContain('?p=');
    expect(ctx.downloads.snapshot().tasks).toEqual([]);
  });

  it('accepts the same video once an LLM is configured', async () => {
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
    expect((await post(API_PATHS.downloadSong, { input: VIDEO_URL })).statusCode).toBe(200);
  });

  it('does not preflight at all when ?p= is explicit', async () => {
    const before = upstream.requests.length;
    await post(API_PATHS.downloadSong, { input: `${VIDEO_URL}?p=2` });
    expect(upstream.requests.slice(before)).toEqual([]);
  });

  it('refuses a keyword with no LLM', async () => {
    const res = await post(API_PATHS.downloadSong, { input: '周杰伦 稻香' });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error_code).toBe('LLM_NOT_CONFIGURED');
  });

  it('refuses a non-bilibili link', async () => {
    const res = await post(API_PATHS.downloadSong, { input: 'https://youtube.com/watch?v=x' });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).message).toContain('不是 B 站链接');
  });

  it('points a list link at fetch-list instead of queuing it', async () => {
    const res = await post(API_PATHS.downloadSong, {
      input: 'https://space.bilibili.com/9666167/favlist?fid=96661672',
    });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).message).toContain('fetch-list');
  });

  it('rejects an unknown body field', async () => {
    const res = await post(API_PATHS.downloadSong, { input: VIDEO_URL, playlist: 'x' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an oversized input', async () => {
    const res = await post(API_PATHS.downloadSong, { input: 'x'.repeat(9000) });
    expect(res.statusCode).toBe(400);
  });

  it('emits a queued status event immediately', async () => {
    await post(API_PATHS.downloadSong, { input: VIDEO_URL });
    expect(events.some((e) => e.type === 'download:status' && e.state === 'queued')).toBe(true);
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

// ─── POST /download/batch ──────────────────────────────

describe('POST /download/batch', () => {
  const videoItem = (page: number | null) => ({
    kind: 'video',
    bvid: BVID,
    page,
    title: null,
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
    await post(API_PATHS.downloadSong, { input: `${VIDEO_URL}?p=1` });
    events.length = 0;
    await post(API_PATHS.downloadBatch, {
      groups: [{ target: { kind: 'all' }, items: [videoItem(1)] }],
    });
    expect(events.filter((e) => e.type === 'download:batches-changed')).toHaveLength(1);
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
        { target: { kind: 'all' }, items: [{ kind: 'video', bvid: 'nope', page: 1, title: null }] },
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
    const first = bodyOf(await post(API_PATHS.downloadSong, { input: `${VIDEO_URL}?p=1` }));
    const second = bodyOf(await post(API_PATHS.downloadSong, { input: `${VIDEO_URL}?p=2` }));

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

describe('GET /download/tasks', () => {
  it('answers a snapshot of tasks and batches', async () => {
    upstream.state.hangAudio = true;
    await post(API_PATHS.downloadSong, { input: `${VIDEO_URL}?p=1` });
    await post(API_PATHS.downloadBatch, {
      groups: [
        { target: { kind: 'all' }, items: [{ kind: 'video', bvid: BVID, page: 2, title: null }] },
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
    const pending = post(API_PATHS.downloadSong, { input: VIDEO_URL });
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
