import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSong, paths } from '@lark/core';
import type { ApiResponse, LarkEvent, SongData } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type TestApp,
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';

let ctx: TestContext;
let app: TestApp;
let nest: string;
let events: LarkEvent[];

const UNKNOWN_UUID = '9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001';

const seed = (name: string, artist = ''): SongData =>
  createSong(ctx.db, ctx.sqlite, { name, artist });

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-songs-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  ctx = createTestContext();
  app = buildTestServer(ctx);
  events = [];
  ctx.eventsBus.subscribe((e) => events.push(e));
});

afterEach(async () => {
  await app.close();
  await closeTestContext(ctx);
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

describe('GET /songs', () => {
  it('lists songs with the filtered total and disk enrichment', async () => {
    const first = seed('青花瓷', '周杰伦');
    seed('稻香', '周杰伦');
    mkdirSync(join(paths.songsDir(), first.id), { recursive: true });
    writeFileSync(join(paths.songsDir(), first.id, 'song.mp3'), 'x'.repeat(64));

    const res = await app.inject({ method: 'GET', url: '/songs' });
    expect(res.statusCode).toBe(200);
    const body = res.json<ApiResponse<SongData[]>>();
    expect(body.total).toBe(2);
    expect(body.data).toHaveLength(2);

    const enriched = body.data?.find((s) => s.id === first.id);
    expect(enriched).toMatchObject({ has_file: true, file_size: 64 });
    expect(body.data?.find((s) => s.id !== first.id)?.has_file).toBe(false);
  });

  it('searches, sorts and paginates', async () => {
    seed('b song', 'artist');
    seed('a song', 'artist');
    seed('unrelated', 'other');

    const searched = await app.inject({ method: 'GET', url: '/songs?search=song&sort=name' });
    expect(searched.json<ApiResponse<SongData[]>>().data?.map((s) => s.name)).toEqual([
      'a song',
      'b song',
    ]);

    const paged = await app.inject({ method: 'GET', url: '/songs?sort=name&limit=1&offset=1' });
    const body = paged.json<ApiResponse<SongData[]>>();
    expect(body.total).toBe(3); // count BEFORE pagination
    expect(body.data).toHaveLength(1);
    expect(body.data?.[0].name).toBe('b song');

    const desc = await app.inject({ method: 'GET', url: '/songs?sort=name&order=desc&limit=1' });
    expect(desc.json<ApiResponse<SongData[]>>().data?.[0].name).toBe('unrelated');
  });

  it.each([
    ['/songs?srot=name', 'INVALID_QUERY'], // a typo must NOT silently use the default
    ['/songs?sort=bogus', 'INVALID_QUERY'],
    ['/songs?order=sideways', 'INVALID_QUERY'],
    ['/songs?limit=0', 'INVALID_QUERY'],
    ['/songs?limit=1001', 'INVALID_QUERY'],
    ['/songs?limit=abc', 'INVALID_QUERY'],
    ['/songs?limit=1.5', 'INVALID_QUERY'],
    ['/songs?offset=-1', 'INVALID_QUERY'],
    [`/songs?search=${'x'.repeat(201)}`, 'INVALID_QUERY'],
  ])('rejects %s', async (url, code) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().error_code).toBe(code);
    expect(ctx.logger.errors()).toHaveLength(0);
  });
});

describe('GET /songs/:id', () => {
  it('returns one enriched song', async () => {
    const song = seed('青花瓷');
    const res = await app.inject({ method: 'GET', url: `/songs/${song.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<ApiResponse<SongData>>().data).toMatchObject({
      id: song.id,
      name: '青花瓷',
      has_file: false,
    });
  });

  it('404s an unknown id and 400s a malformed one', async () => {
    expect((await app.inject({ method: 'GET', url: `/songs/${UNKNOWN_UUID}` })).statusCode).toBe(
      404,
    );
    const bad = await app.inject({ method: 'GET', url: '/songs/not-a-uuid' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<ApiResponse>().error_code).toBe('INVALID_ID');
  });
});

describe('PUT /songs/:id', () => {
  it('updates fields, trims what it stores, and announces the change', async () => {
    const song = seed('old', 'old artist');
    const res = await app.inject({
      method: 'PUT',
      url: `/songs/${song.id}`,
      payload: { name: '  新名字  ', artist: '', lyrics_offset: -0.5, duration: 12.5 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<ApiResponse<SongData>>().data).toMatchObject({
      name: '新名字', // stored trimmed, not just validated trimmed
      artist: '',
      lyrics_offset: -0.5,
      duration: 12.5,
    });
    expect(events).toEqual([{ type: 'songs:changed' }]);
  });

  it.each([
    ['unknown field', { nmae: 'x' }, 'INVALID_BODY'],
    ['an empty patch', {}, 'INVALID_BODY'],
    ['a blank name', { name: '   ' }, 'INVALID_BODY'],
    ['an over-long name', { name: 'x'.repeat(501) }, 'INVALID_BODY'],
    ['a non-string name', { name: 42 }, 'INVALID_BODY'],
    ['a non-numeric offset', { lyrics_offset: '1' }, 'INVALID_BODY'],
    ['a negative duration', { duration: -1 }, 'INVALID_BODY'],
    ['an over-long source_key', { source_key: 'x'.repeat(257) }, 'INVALID_BODY'],
    ['an over-long source_url', { source_url: `https://x/${'y'.repeat(2048)}` }, 'INVALID_BODY'],
  ])('rejects %s', async (_label, payload, code) => {
    const song = seed('s');
    const res = await app.inject({ method: 'PUT', url: `/songs/${song.id}`, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().error_code).toBe(code);
    expect(events).toEqual([]);
  });

  describe('source triple (M1 four quadrants)', () => {
    it('accepts provider+key together', async () => {
      const song = seed('s');
      const res = await app.inject({
        method: 'PUT',
        url: `/songs/${song.id}`,
        payload: { source_provider: 'bilibili', source_key: 'BV1xx411c7mD:12345' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<ApiResponse<SongData>>().data?.source_key).toBe('BV1xx411c7mD:12345');
    });

    it('accepts a url with no identity (hand-typed link, R8)', async () => {
      const song = seed('s');
      const res = await app.inject({
        method: 'PUT',
        url: `/songs/${song.id}`,
        payload: { source_url: 'https://example.com/track' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<ApiResponse<SongData>>().data).toMatchObject({
        source_url: 'https://example.com/track',
        source_provider: null,
      });
    });

    it('rejects half of the identity pair', async () => {
      const song = seed('s');
      const res = await app.inject({
        method: 'PUT',
        url: `/songs/${song.id}`,
        payload: { source_provider: 'bilibili' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<ApiResponse>().error_code).toBe('INVALID_SOURCE');
    });

    it('rejects a key that does not look like an identity', async () => {
      const song = seed('s');
      const res = await app.inject({
        method: 'PUT',
        url: `/songs/${song.id}`,
        payload: { source_provider: 'bilibili', source_key: 'BV1xx411c7mD' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<ApiResponse>().error_code).toBe('INVALID_SOURCE');
    });

    it('409s a key that belongs to another song, naming it', async () => {
      const owner = createSong(ctx.db, ctx.sqlite, {
        name: 'owner',
        source_provider: 'bilibili',
        source_key: 'BV1xx411c7mD:12345',
      });
      const other = seed('other');

      const res = await app.inject({
        method: 'PUT',
        url: `/songs/${other.id}`,
        payload: { source_provider: 'bilibili', source_key: 'BV1xx411c7mD:12345' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<ApiResponse>()).toMatchObject({
        error_code: 'SOURCE_KEY_CONFLICT',
        details: { conflicting_song_id: owner.id },
      });
      expect(ctx.logger.errors()).toHaveLength(0);
    });
  });
});

describe('DELETE /songs/:id', () => {
  it('deletes and announces both songs and playlists', async () => {
    const song = seed('s');
    const res = await app.inject({ method: 'DELETE', url: `/songs/${song.id}` });
    expect(res.statusCode).toBe(200);
    expect(events).toEqual([{ type: 'songs:changed' }, { type: 'playlists:changed' }]);

    const after = await app.inject({ method: 'GET', url: `/songs/${song.id}` });
    expect(after.statusCode).toBe(404);
  });

  it('404s an unknown id without emitting anything', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/songs/${UNKNOWN_UUID}` });
    expect(res.statusCode).toBe(404);
    expect(events).toEqual([]);
  });
});

describe('PUT /songs/:id/pin', () => {
  it('pins without touching updated_at (local field, R18)', async () => {
    const song = seed('s');
    const res = await app.inject({
      method: 'PUT',
      url: `/songs/${song.id}/pin`,
      payload: { pinned: true },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json<ApiResponse<SongData>>().data;
    expect(data?.pinned).toBe(true);
    expect(data?.updated_at).toBe(song.updated_at);
    expect(events).toEqual([{ type: 'songs:changed' }]);
  });

  it('rejects a non-boolean pinned', async () => {
    const song = seed('s');
    const res = await app.inject({
      method: 'PUT',
      url: `/songs/${song.id}/pin`,
      payload: { pinned: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().error_code).toBe('INVALID_BODY');
  });
});
