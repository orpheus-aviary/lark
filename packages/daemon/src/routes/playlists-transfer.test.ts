// Export / import over HTTP (M5-12 / M5-13). core owns the matching rules and
// the transaction; what is tested here is the route's half of the contract —
// the file arrives as a PATH, the size is bounded before anything is parsed,
// and the commit refuses a file that changed since the preview.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSongsToPlaylist, createPlaylist, createSong } from '@lark/core';
import {
  API_PATHS,
  type ApiResponse,
  type LarkEvent,
  type PlaylistExportData,
  type PlaylistImportData,
  type PlaylistImportPreviewData,
  apiPath,
} from '@lark/shared';
import type { LightMyRequestResponse } from 'fastify';
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
let files: string;
let events: LarkEvent[];

const UNKNOWN_UUID = '9b2abf8a-6b31-40d4-a2f1-8e5c3d21a001';

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-transfer-'));
  files = mkdtempSync(join(tmpdir(), 'lark-transfer-files-'));
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
  rmSync(files, { recursive: true, force: true });
});

interface FileSong {
  name: string;
  artist?: string;
  source_provider?: string | null;
  source_key?: string | null;
}

/** Write an import file and hand back its path. */
function writeImportFile(songs: readonly FileSong[], name = '导入的歌单'): string {
  const path = join(files, `import-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      format: 'lark-playlist',
      version: 1,
      exported_at: 1789000000000,
      playlist: { name },
      songs,
    }),
  );
  return path;
}

const seedSong = (name: string, key?: string) =>
  createSong(ctx.db, ctx.sqlite, {
    name,
    ...(key === undefined ? {} : { source_provider: 'bilibili', source_key: key }),
  });

async function preview(filePath: string): Promise<PlaylistImportPreviewData> {
  const res = await app.inject({
    method: 'POST',
    url: API_PATHS.playlistImportPreview,
    payload: { file_path: filePath },
  });
  expect(res.statusCode).toBe(200);
  return res.json<ApiResponse<PlaylistImportPreviewData>>().data as PlaylistImportPreviewData;
}

describe('GET /playlists/:id/export', () => {
  it('exports a playlist in its own order', async () => {
    const playlist = createPlaylist(ctx.db, ctx.sqlite, '健身');
    const first = seedSong('甲', 'BV1aaa:1');
    const second = seedSong('乙', 'BV1bbb:2');
    addSongsToPlaylist(ctx.db, ctx.sqlite, playlist.id, [second.id, first.id]);

    const res = await app.inject({ method: 'GET', url: apiPath.playlistExport(playlist.id) });
    const data = res.json<ApiResponse<PlaylistExportData>>().data as PlaylistExportData;

    expect(res.statusCode).toBe(200);
    expect(data.format).toBe('lark-playlist');
    expect(data.version).toBe(1);
    expect(data.playlist.name).toBe('健身');
    expect(data.songs.map((s) => s.name)).toEqual(['乙', '甲']);
    expect(data.songs[0]).not.toHaveProperty('id');
  });

  it('exports the whole library through the virtual all', async () => {
    seedSong('库里的歌');
    const res = await app.inject({ method: 'GET', url: apiPath.playlistExport('all') });
    const data = res.json<ApiResponse<PlaylistExportData>>().data as PlaylistExportData;
    expect(data.playlist.name).toBe('all');
    expect(data.songs).toHaveLength(1);
  });

  it('404s an unknown playlist and 400s a non-uuid', async () => {
    const missing = await app.inject({ method: 'GET', url: apiPath.playlistExport(UNKNOWN_UUID) });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({ method: 'GET', url: apiPath.playlistExport('not-a-uuid') });
    expect(bad.statusCode).toBe(400);
  });
});

describe('POST /playlists/import-preview', () => {
  it('reports what an import would do, and writes nothing', async () => {
    seedSong('已有的', 'BV1aaa:1');
    const path = writeImportFile([
      { name: '随便叫什么', source_provider: 'bilibili', source_key: 'BV1aaa:1' },
      { name: '新的', source_provider: 'bilibili', source_key: 'BV1ccc:3' },
    ]);

    const data = await preview(path);

    expect(data).toMatchObject({
      total: 2,
      reuse_count: 1,
      new_count: 1,
      playlist_name: '导入的歌单',
      suspects: [],
    });
    expect(data.digest).toMatch(/^[0-9a-f]{64}$/);
    const after = await app.inject({ method: 'GET', url: API_PATHS.songs });
    expect(after.json<ApiResponse<unknown[]>>().data).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('lists a suspect with its candidates', async () => {
    const existing = seedSong('晴天', 'BV1aaa:1');
    const path = writeImportFile([
      { name: '晴天', source_provider: 'bilibili', source_key: 'BV1zzz:9' },
    ]);

    const data = await preview(path);

    expect(data.new_count).toBe(1);
    expect(data.suspects).toHaveLength(1);
    expect(data.suspects[0]).toMatchObject({ index: 0, name: '晴天' });
    expect(data.suspects[0].candidates).toEqual([
      { id: existing.id, name: '晴天', artist: '', has_file: false },
    ]);
  });

  it('400s an unreadable path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: API_PATHS.playlistImportPreview,
      payload: { file_path: join(files, 'nope.json') },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().error_code).toBe('INVALID_IMPORT_FILE');
  });

  it('400s a file past the size limit before parsing it', async () => {
    const path = join(files, 'huge.json');
    writeFileSync(path, Buffer.alloc(20 * 1024 * 1024 + 1));
    const res = await app.inject({
      method: 'POST',
      url: API_PATHS.playlistImportPreview,
      payload: { file_path: path },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().error_code).toBe('INVALID_IMPORT_FILE');
  });

  it('400s a file this build is too old to read', async () => {
    const path = join(files, 'v2.json');
    writeFileSync(
      path,
      JSON.stringify({ format: 'lark-playlist', version: 2, playlist: { name: 'x' }, songs: [] }),
    );
    const res = await app.inject({
      method: 'POST',
      url: API_PATHS.playlistImportPreview,
      payload: { file_path: path },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().error_code).toBe('UNSUPPORTED_FORMAT_VERSION');
  });
});

describe('POST /playlists/import', () => {
  // Explicit return type: `inject` answers an intersection that includes
  // `void`, and a helper without one stops `await` from narrowing (M3 §7).
  const commit = (
    filePath: string,
    digest: string,
    target: unknown,
    reuse?: unknown,
  ): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'POST',
      url: API_PATHS.playlistImport,
      payload: {
        file_path: filePath,
        digest,
        target,
        ...(reuse === undefined ? {} : { reuse }),
      },
    });

  it('imports into a new playlist and announces both changes', async () => {
    const path = writeImportFile([
      { name: '甲', source_provider: 'bilibili', source_key: 'BV1aaa:1' },
      { name: '乙', source_provider: 'bilibili', source_key: 'BV1bbb:2' },
    ]);
    const { digest, playlist_name } = await preview(path);

    const res = await commit(path, digest, { kind: 'new', name: playlist_name });
    const data = res.json<ApiResponse<PlaylistImportData>>().data as PlaylistImportData;

    expect(res.statusCode).toBe(200);
    expect(data).toMatchObject({ total: 2, created: 2, reused: 0, added: 2 });
    expect(events.map((e) => e.type)).toEqual(['songs:changed', 'playlists:changed']);

    const members = await app.inject({
      method: 'GET',
      url: apiPath.playlistSongs(data.playlist_id as string),
    });
    expect(members.json<ApiResponse<{ name: string }[]>>().data?.map((s) => s.name)).toEqual([
      '甲',
      '乙',
    ]);
  });

  it('imports into the library only for the virtual all', async () => {
    const path = writeImportFile([
      { name: '只入库', source_provider: 'bilibili', source_key: 'BV1ddd:4' },
    ]);
    const { digest } = await preview(path);

    const res = await commit(path, digest, { kind: 'all' });
    const data = res.json<ApiResponse<PlaylistImportData>>().data as PlaylistImportData;

    expect(data).toMatchObject({ playlist_id: null, created: 1, added: 0 });
    const playlists = await app.inject({ method: 'GET', url: API_PATHS.playlists });
    expect(playlists.json<ApiResponse<unknown[]>>().data).toHaveLength(1); // just `all`
  });

  it('refuses a file that changed since the preview', async () => {
    const path = writeImportFile([
      { name: '原来的', source_provider: 'bilibili', source_key: 'BV1aaa:1' },
    ]);
    const { digest } = await preview(path);
    writeFileSync(
      path,
      JSON.stringify({
        format: 'lark-playlist',
        version: 1,
        playlist: { name: '换了' },
        songs: [{ name: '换过的', source_provider: 'bilibili', source_key: 'BV1eee:5' }],
      }),
    );

    const res = await commit(path, digest, { kind: 'all' });

    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().error_code).toBe('IMPORT_SOURCE_CHANGED');
    const songs = await app.inject({ method: 'GET', url: API_PATHS.songs });
    expect(songs.json<ApiResponse<unknown[]>>().data).toEqual([]);
  });

  it('refuses a reuse instruction the commit cannot verify', async () => {
    const unrelated = seedSong('毫不相干', 'BV1aaa:1');
    const path = writeImportFile([
      { name: '晴天', source_provider: 'bilibili', source_key: 'BV1zzz:9' },
    ]);
    const { digest } = await preview(path);

    const res = await commit(path, digest, { kind: 'all' }, [{ index: 0, song_id: unrelated.id }]);

    expect(res.statusCode).toBe(400);
    expect(res.json<ApiResponse>().error_code).toBe('INVALID_REUSE');
  });

  it('honours a reuse instruction that still holds', async () => {
    const existing = seedSong('晴天');
    const path = writeImportFile([
      { name: '晴天', source_provider: 'bilibili', source_key: 'BV1zzz:9' },
    ]);
    const { digest } = await preview(path);

    const res = await commit(path, digest, { kind: 'all' }, [{ index: 0, song_id: existing.id }]);
    const data = res.json<ApiResponse<PlaylistImportData>>().data as PlaylistImportData;

    expect(data).toMatchObject({ created: 0, reused: 1 });
  });

  it('404s a target playlist that is gone, importing nothing (R27)', async () => {
    const path = writeImportFile([
      { name: '甲', source_provider: 'bilibili', source_key: 'BV1aaa:1' },
    ]);
    const { digest } = await preview(path);

    const res = await commit(path, digest, { kind: 'playlist', playlist_id: UNKNOWN_UUID });

    expect(res.statusCode).toBe(404);
    const songs = await app.inject({ method: 'GET', url: API_PATHS.songs });
    expect(songs.json<ApiResponse<unknown[]>>().data).toEqual([]);
    expect(events).toEqual([]);
  });

  it.each([
    ['an unknown field', { file_path: 'x', digest: 'a', target: { kind: 'all' }, oops: 1 }],
    ['a non-hex digest', { file_path: 'x', digest: 'not-a-digest', target: { kind: 'all' } }],
    ['a bad target kind', { file_path: 'x', digest: 'a'.repeat(64), target: { kind: 'nope' } }],
    [
      'a malformed reuse entry',
      {
        file_path: 'x',
        digest: 'a'.repeat(64),
        target: { kind: 'all' },
        reuse: [{ index: -1, song_id: UNKNOWN_UUID }],
      },
    ],
  ])('400s %s before touching the disk', async (_label, payload) => {
    const res = await app.inject({ method: 'POST', url: API_PATHS.playlistImport, payload });
    expect(res.statusCode).toBe(400);
  });
});
