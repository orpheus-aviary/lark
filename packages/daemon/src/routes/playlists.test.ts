import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSongsToPlaylist, createPlaylist, createSong } from '@lark/core';
import type { ApiResponse, LarkEvent, PlaylistData, SongData } from '@lark/shared';
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

const seedSong = (name: string): SongData => createSong(ctx.db, ctx.sqlite, { name });
const seedPlaylist = (name: string): PlaylistData => createPlaylist(ctx.db, ctx.sqlite, name);

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-playlists-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  ctx = createTestContext();
  app = buildTestServer(ctx);
  events = [];
  ctx.eventsBus.subscribe((e) => events.push(e));
});

afterEach(async () => {
  await app.close();
  closeTestContext(ctx);
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

describe('GET /playlists', () => {
  it('puts the virtual all list first, carrying the library size', async () => {
    seedSong('s1');
    seedSong('s2');
    const real = seedPlaylist('favourites');

    const res = await app.inject({ method: 'GET', url: '/playlists' });
    const data = res.json<ApiResponse<PlaylistData[]>>().data;
    expect(data?.[0]).toEqual({
      id: 'all',
      name: 'all',
      created_at: 0,
      updated_at: 0,
      song_count: 2,
    });
    expect(data?.[1]).toMatchObject({ id: real.id, song_count: 0 });
  });
});

describe('GET /playlists/:id', () => {
  it('answers for the virtual list, a real one, and neither', async () => {
    const real = seedPlaylist('favourites');
    seedSong('s1');

    const all = await app.inject({ method: 'GET', url: '/playlists/all' });
    expect(all.json<ApiResponse<PlaylistData>>().data).toMatchObject({ id: 'all', song_count: 1 });

    const one = await app.inject({ method: 'GET', url: `/playlists/${real.id}` });
    expect(one.json<ApiResponse<PlaylistData>>().data).toMatchObject({
      id: real.id,
      name: 'favourites',
      song_count: 0,
    });

    expect(
      (await app.inject({ method: 'GET', url: `/playlists/${UNKNOWN_UUID}` })).statusCode,
    ).toBe(404);
    const malformed = await app.inject({ method: 'GET', url: '/playlists/nope' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<ApiResponse>().error_code).toBe('INVALID_ID');
  });
});

describe('GET /playlists/:id/songs', () => {
  it('returns every song for all, and rank order for a real playlist', async () => {
    const first = seedSong('first');
    const second = seedSong('second');
    const playlist = seedPlaylist('p');
    addSongsToPlaylist(ctx.db, ctx.sqlite, playlist.id, [second.id, first.id]);

    const all = await app.inject({ method: 'GET', url: '/playlists/all/songs' });
    const allBody = all.json<ApiResponse<SongData[]>>();
    // created_at asc, tie-broken by id asc — both rows are created inside the
    // same millisecond here, so the tie-break IS the assertion.
    expect(allBody.data?.map((s) => s.id)).toEqual([first.id, second.id].sort());
    expect(allBody.total).toBe(2);
    expect(allBody.data?.[0].has_file).toBe(false); // enriched like GET /songs

    const members = await app.inject({ method: 'GET', url: `/playlists/${playlist.id}/songs` });
    expect(members.json<ApiResponse<SongData[]>>().data?.map((s) => s.id)).toEqual([
      second.id,
      first.id,
    ]);
  });
});

describe('playlist writes', () => {
  it('creates, renames and deletes, announcing each change', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/playlists',
      payload: { name: '  收藏  ' },
    });
    expect(created.statusCode).toBe(200);
    const playlist = created.json<ApiResponse<PlaylistData>>().data as PlaylistData;
    expect(playlist.name).toBe('收藏'); // trimmed on the way in

    const renamed = await app.inject({
      method: 'PUT',
      url: `/playlists/${playlist.id}`,
      payload: { name: '最爱' },
    });
    expect(renamed.json<ApiResponse<PlaylistData>>().data?.name).toBe('最爱');

    const deleted = await app.inject({ method: 'DELETE', url: `/playlists/${playlist.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(events).toEqual([
      { type: 'playlists:changed' },
      { type: 'playlists:changed' },
      { type: 'playlists:changed' },
    ]);
  });

  it('adds, removes and reorders members', async () => {
    const a = seedSong('a');
    const b = seedSong('b');
    const c = seedSong('c');
    const playlist = seedPlaylist('p');

    const added = await app.inject({
      method: 'POST',
      url: `/playlists/${playlist.id}/songs`,
      payload: { song_ids: [a.id, b.id, c.id] },
    });
    expect(added.json<ApiResponse<{ added: number }>>().data?.added).toBe(3);

    // Move c between a and b — anchors, never indexes (R7).
    const reordered = await app.inject({
      method: 'POST',
      url: `/playlists/${playlist.id}/reorder`,
      payload: { song_id: c.id, after_song_id: a.id, before_song_id: b.id },
    });
    expect(reordered.statusCode).toBe(200);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/playlists/${playlist.id}/songs/${a.id}`,
    });
    expect(removed.statusCode).toBe(200);

    const members = await app.inject({ method: 'GET', url: `/playlists/${playlist.id}/songs` });
    expect(members.json<ApiResponse<SongData[]>>().data?.map((s) => s.id)).toEqual([c.id, b.id]);
  });

  it('rejects non-adjacent anchors instead of guessing intent', async () => {
    const [a, b, c] = [seedSong('a'), seedSong('b'), seedSong('c')];
    const playlist = seedPlaylist('p');
    addSongsToPlaylist(ctx.db, ctx.sqlite, playlist.id, [a.id, b.id, c.id]);

    const res = await app.inject({
      method: 'POST',
      url: `/playlists/${playlist.id}/reorder`,
      payload: { song_id: a.id, after_song_id: c.id, before_song_id: b.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().error_code).toBe('INVALID_REORDER');
    expect(ctx.logger.errors()).toHaveLength(0);
  });

  it('404s a member that is not in the playlist', async () => {
    const song = seedSong('a');
    const playlist = seedPlaylist('p');
    const res = await app.inject({
      method: 'DELETE',
      url: `/playlists/${playlist.id}/songs/${song.id}`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('input contract', () => {
  it.each([
    ['an empty name', { name: '  ' }],
    ['an over-long name', { name: 'x'.repeat(501) }],
    ['an unknown field', { name: 'p', colour: 'red' }],
    ['a missing name', {}],
  ])('rejects %s on create', async (_label, payload) => {
    const res = await app.inject({ method: 'POST', url: '/playlists', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().error_code).toBe('INVALID_BODY');
  });

  it.each([
    ['an empty list', { song_ids: [] }, 'INVALID_BODY'],
    [
      'a list of 1001',
      { song_ids: Array.from({ length: 1001 }, () => UNKNOWN_UUID) },
      'INVALID_BODY',
    ],
    ['a non-uuid member', { song_ids: ['abc'] }, 'INVALID_ID'],
    ['a non-array', { song_ids: 'abc' }, 'INVALID_BODY'],
  ])('rejects %s when adding songs', async (_label, payload, code) => {
    const playlist = seedPlaylist('p');
    const res = await app.inject({
      method: 'POST',
      url: `/playlists/${playlist.id}/songs`,
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().error_code).toBe(code);
  });

  it('rejects a non-uuid reorder anchor', async () => {
    const playlist = seedPlaylist('p');
    const res = await app.inject({
      method: 'POST',
      url: `/playlists/${playlist.id}/reorder`,
      payload: { song_id: UNKNOWN_UUID, before_song_id: 'first' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().error_code).toBe('INVALID_ID');
  });
});

describe('the virtual all playlist is read-only (R24)', () => {
  it.each([
    ['PUT', '/playlists/all', { name: 'renamed' }],
    ['DELETE', '/playlists/all', undefined],
    ['POST', '/playlists/all/songs', { song_ids: [UNKNOWN_UUID] }],
    ['DELETE', `/playlists/all/songs/${UNKNOWN_UUID}`, undefined],
    ['POST', '/playlists/all/reorder', { song_id: UNKNOWN_UUID, after_song_id: UNKNOWN_UUID }],
  ])('%s %s → 400 VIRTUAL_PLAYLIST', async (method, url, payload) => {
    const res = await app.inject({
      method: method as 'PUT' | 'POST' | 'DELETE',
      url,
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().error_code).toBe('VIRTUAL_PLAYLIST');
    expect(events).toEqual([]);
  });
});
