// The M3 additions to the songs surface: import, recognize-url, redownload,
// the four-branch source edit, and the claim guards that keep a delete from
// racing a download.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createSong, paths, resolveFfmpegBinaries } from '@lark/core';
import { type FakeUpstream, startFakeUpstream } from '@lark/core/testing';
import { API_PATHS, type SongData, apiPath } from '@lark/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
let nest: string;
let fixtures: string;
let mp3Path: string;
let fakeMp3Path: string;

beforeAll(async () => {
  fixtures = mkdtempSync(join(tmpdir(), 'lark-import-fixtures-'));
  mp3Path = join(fixtures, '稻香.mp3');
  fakeMp3Path = join(fixtures, 'actually-aac.mp3');
  const { ffmpeg } = resolveFfmpegBinaries();
  const run = promisify(execFile);
  await run(ffmpeg.path, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:a',
    'libmp3lame',
    '-f',
    'mp3',
    '-y',
    mp3Path,
  ]);
  // An AAC file wearing a .mp3 extension — the case only the container check
  // catches (fifth review ⑨).
  await run(ffmpeg.path, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:a',
    'aac',
    '-f',
    'mp4',
    '-y',
    fakeMp3Path,
  ]);
}, 60_000);

beforeEach(async () => {
  nest = mkdtempSync(join(tmpdir(), 'lark-songs-m3-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  upstream = await startFakeUpstream();
  ctx = createTestContext({ bilibiliBase: upstream.baseUrl });
  app = buildTestServer(ctx);
});

afterEach(async () => {
  await app.close();
  await closeTestContext(ctx);
  await upstream.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

const seed = (name: string, source?: Partial<SongData>): SongData =>
  createSong(ctx.db, ctx.sqlite, {
    name,
    source_url: source?.source_url ?? null,
    source_provider: source?.source_provider ?? null,
    source_key: source?.source_key ?? null,
  });

const post = async (
  url: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: string }> => {
  const res = await app.inject({ method: 'POST', url, payload });
  return { statusCode: res.statusCode, body: res.body };
};

const put = async (
  url: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: string }> => {
  const res = await app.inject({ method: 'PUT', url, payload });
  return { statusCode: res.statusCode, body: res.body };
};

const bodyOf = (res: { body: string }) => JSON.parse(res.body);

// ─── POST /songs/import ────────────────────────────────

describe('POST /songs/import', () => {
  it('imports an mp3 with its duration and marks it as a user asset', async () => {
    const res = await post(API_PATHS.songImport, { file_paths: [mp3Path] });
    expect(res.statusCode).toBe(200);

    const { imported, failed } = bodyOf(res).data;
    expect(failed).toEqual([]);
    expect(imported).toHaveLength(1);
    expect(imported[0].name).toBe('稻香');

    const songId = imported[0].song_id;
    const listed = await app.inject({ method: 'GET', url: apiPath.song(songId) });
    // `imported`, never `downloaded`: cache eviction must not reclaim it (R1).
    expect(listed.json().data).toMatchObject({ file_origin: 'imported', artist: '' });
    expect(listed.json().data.duration).toBeGreaterThan(0.9);
    expect(readdirSync(join(paths.songsDir(), songId))).toEqual(['song.mp3']);
  }, 60_000);

  // Extension checks cannot see this; only the container can.
  it('refuses an AAC file wearing a .mp3 extension, and says why', async () => {
    const res = await post(API_PATHS.songImport, { file_paths: [fakeMp3Path] });
    const { imported, failed } = bodyOf(res).data;
    expect(imported).toEqual([]);
    expect(failed[0].reason).toMatch(/实际格式/);
    // No half-created song directory left behind.
    expect(readdirSync(paths.songsDir())).toEqual([]);
  }, 60_000);

  it('reports per-file outcomes instead of failing the batch', async () => {
    const missing = join(fixtures, 'nope.mp3');
    const res = await post(API_PATHS.songImport, { file_paths: [mp3Path, missing] });
    const { imported, failed } = bodyOf(res).data;
    expect(imported).toHaveLength(1);
    expect(failed).toEqual([{ path: missing, reason: expect.any(String) }]);
  }, 60_000);

  it('refuses a non-mp3 extension without probing it', async () => {
    const flac = join(fixtures, 'song.flac');
    writeFileSync(flac, 'x');
    const res = await post(API_PATHS.songImport, { file_paths: [flac] });
    expect(bodyOf(res).data.failed[0].reason).toContain('.mp3');
  });

  it('enforces the batch guardrails', async () => {
    expect((await post(API_PATHS.songImport, { file_paths: [] })).statusCode).toBe(400);
    expect(
      (await post(API_PATHS.songImport, { file_paths: Array(201).fill(mp3Path) })).statusCode,
    ).toBe(400);
    expect((await post(API_PATHS.songImport, { file_paths: [42] })).statusCode).toBe(400);
  });
});

// ─── PUT /songs/:id — the four branches ────────────────

describe('PUT /songs/:id source_url', () => {
  it('normalises a bilibili URL into the full triple', async () => {
    const song = seed('s');
    const res = await put(apiPath.song(song.id), { source_url: `${VIDEO_URL}?spm_id_from=333` });

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).data).toMatchObject({
      source_url: VIDEO_URL, // tracking parameters stripped
      source_provider: 'bilibili',
      source_key: `${BVID}:550103819`,
    });
  });

  // The trap `updateSongInTx` sets: absent fields INHERIT, so a url-only edit
  // has to clear the identity explicitly or the song keeps a key for a video
  // it no longer points at.
  it('clears a stale identity when the url changes to a non-bilibili one', async () => {
    const song = seed('s', {
      source_url: VIDEO_URL,
      source_provider: 'bilibili',
      source_key: `${BVID}:550103819`,
    });
    const res = await put(apiPath.song(song.id), { source_url: 'https://example.com/track' });
    expect(bodyOf(res).data).toMatchObject({
      source_url: 'https://example.com/track',
      source_provider: null,
      source_key: null,
    });
  });

  it('clears all three when the url is cleared', async () => {
    const song = seed('s', {
      source_url: VIDEO_URL,
      source_provider: 'bilibili',
      source_key: `${BVID}:550103819`,
    });
    const res = await put(apiPath.song(song.id), { source_url: null });
    expect(bodyOf(res).data).toMatchObject({
      source_url: null,
      source_provider: null,
      source_key: null,
    });
  });

  it('refuses a scheme that is not http(s)', async () => {
    const song = seed('s');
    const res = await put(apiPath.song(song.id), { source_url: 'javascript:alert(1)' });
    expect(res.statusCode).toBe(400);
  });

  // An explicit triple is the client saying what to store; core's invariant is
  // the only judge, and no network call happens.
  it('leaves an explicit triple alone', async () => {
    const song = seed('s');
    const before = upstream.requests.length;
    const res = await put(apiPath.song(song.id), {
      source_url: VIDEO_URL,
      source_provider: 'bilibili',
      source_key: 'BV1xxxxxxxxx:999',
    });
    expect(bodyOf(res).data.source_key).toBe('BV1xxxxxxxxx:999');
    expect(upstream.requests.slice(before)).toEqual([]);
  });
});

// ─── POST /songs/:id/recognize-url ─────────────────────

describe('POST /songs/:id/recognize-url', () => {
  it('previews the triple and the video title without writing anything', async () => {
    const song = seed('s', { source_url: VIDEO_URL });
    const res = await post(apiPath.songRecognizeUrl(song.id), {});

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).data).toMatchObject({
      source_url: VIDEO_URL,
      source_provider: 'bilibili',
      source_key: `${BVID}:550103819`,
      video_title: '【私藏馆】周杰伦《稻香》',
    });

    // R6: a preview writes nothing.
    const stored = await app.inject({ method: 'GET', url: apiPath.song(song.id) });
    expect(stored.json().data.source_key).toBeNull();
  });

  it('accepts an override url for a song that has none', async () => {
    const song = seed('s');
    const res = await post(apiPath.songRecognizeUrl(song.id), { url: VIDEO_URL });
    expect(bodyOf(res).data.source_key).toBe(`${BVID}:550103819`);
  });

  it('400s when there is no url to recognise', async () => {
    const song = seed('s');
    expect((await post(apiPath.songRecognizeUrl(song.id), {})).statusCode).toBe(400);
  });

  it('404s an unknown song', async () => {
    const res = await post(apiPath.songRecognizeUrl('9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001'), {
      url: VIDEO_URL,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /songs/:id/redownload ────────────────────────

describe('POST /songs/:id/redownload', () => {
  it('queues a redownload for a song with a source key', async () => {
    const song = seed('s', {
      source_url: VIDEO_URL,
      source_provider: 'bilibili',
      source_key: `${BVID}:550103819`,
    });
    const res = await post(apiPath.songRedownload(song.id), {});
    expect(res.statusCode).toBe(200);
    expect(ctx.downloads.snapshot().tasks[0]).toMatchObject({ kind: 'redownload' });
    ctx.downloads.cancel(bodyOf(res).data.task_id);
  });

  // Re-identifying needs the model, and that is knowable synchronously.
  it('refuses a song with no key when no LLM is configured', async () => {
    const song = seed('s');
    const res = await post(apiPath.songRedownload(song.id), {});
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error_code).toBe('LLM_NOT_CONFIGURED');
    expect(ctx.downloads.snapshot().tasks).toEqual([]);
  });

  it('accepts it once an LLM is configured', async () => {
    ctx.config.llm = { url: upstream.llmUrl(), model: 'm', api_key: 'k', api_format: 'openai' };
    const song = seed('s');
    expect((await post(apiPath.songRedownload(song.id), {})).statusCode).toBe(200);
    for (const task of ctx.downloads.snapshot().tasks) ctx.downloads.cancel(task.id);
  });

  it('404s an unknown song', async () => {
    const res = await post(apiPath.songRedownload('9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001'), {});
    expect(res.statusCode).toBe(404);
  });
});

// ─── Claim guards ──────────────────────────────────────

describe('claims', () => {
  it('409s a delete while a writer holds the song', async () => {
    const song = seed('s');
    const held = ctx.downloads.claims.acquire(song.id, 'file', 'task-1');

    const res = await app.inject({ method: 'DELETE', url: apiPath.song(song.id) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error_code).toBe('SONG_BUSY');
    expect(res.json().details).toMatchObject({ song_id: song.id });

    ctx.downloads.claims.release(held);
    expect((await app.inject({ method: 'DELETE', url: apiPath.song(song.id) })).statusCode).toBe(
      200,
    );
  });

  it('409s a source edit while a download holds the song', async () => {
    const song = seed('s');
    const held = ctx.downloads.claims.acquire(song.id, 'file', 'task-1');
    const res = await put(apiPath.song(song.id), { name: 'renamed' });
    expect(res.statusCode).toBe(409);
    ctx.downloads.claims.release(held);
  });

  // lyrics and file deliberately coexist — a lyrics fetch must not block the
  // user from editing the song's link.
  it('lets a source edit through while only a lyrics task holds the song', async () => {
    const song = seed('s');
    const held = ctx.downloads.claims.acquire(song.id, 'lyrics', 'task-1');
    expect((await put(apiPath.song(song.id), { name: 'renamed' })).statusCode).toBe(200);
    ctx.downloads.claims.release(held);
  });

  it('409s a lyrics delete while a lyrics task holds the song', async () => {
    const song = seed('s');
    const held = ctx.downloads.claims.acquire(song.id, 'lyrics', 'task-1');
    const res = await app.inject({ method: 'DELETE', url: apiPath.lyrics(song.id) });
    expect(res.statusCode).toBe(409);
    ctx.downloads.claims.release(held);
  });

  it('releases the route claim even when the operation fails', async () => {
    const song = seed('s');
    // A duplicate key makes the update throw; the claim must not survive it.
    seed('other', {
      source_url: null,
      source_provider: 'bilibili',
      source_key: `${BVID}:1`,
    });
    const res = await put(apiPath.song(song.id), {
      source_provider: 'bilibili',
      source_key: `${BVID}:1`,
    });
    expect(res.statusCode).toBe(409);
    expect(ctx.downloads.claims.describe(song.id)).toEqual([]);
  });
});

// ─── Audio route integration ───────────────────────────

describe('GET /audio/:id after an import', () => {
  it('serves the imported file', async () => {
    const imported = bodyOf(await post(API_PATHS.songImport, { file_paths: [mp3Path] })).data;
    const songId = imported.imported[0].song_id;
    expect(existsSync(join(paths.songsDir(), songId, 'song.mp3'))).toBe(true);

    const res = await app.inject({ method: 'GET', url: apiPath.audio(songId) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
  }, 60_000);
});
