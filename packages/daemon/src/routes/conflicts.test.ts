import { randomUUID } from 'node:crypto';
import { recordConflict } from '@lark/core';
import {
  API_PATHS,
  type ApiResponse,
  type ConflictCountData,
  type ConflictData,
  type ConflictListData,
  type LarkEvent,
  type SongSyncPayload,
  apiPath,
} from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestApp,
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';

let ctx: TestContext;
let app: TestApp;
let events: LarkEvent[];

beforeEach(() => {
  ctx = createTestContext();
  app = buildTestServer(ctx);
  events = [];
  ctx.eventsBus.subscribe((event) => events.push(event));
});

afterEach(async () => {
  await closeTestContext(ctx);
});

/** Explicit return type: `app.inject`'s own includes `void` (M3 lesson). */
interface Injected {
  statusCode: number;
  body: string;
}

const get = async (url: string): Promise<Injected> => {
  const res = await app.inject({ method: 'GET', url });
  return { statusCode: res.statusCode, body: res.body };
};
const post = async (url: string, payload?: Record<string, unknown>): Promise<Injected> => {
  const res = await app.inject({
    method: 'POST',
    url,
    ...(payload === undefined ? {} : { payload }),
  });
  return { statusCode: res.statusCode, body: res.body };
};
const bodyOf = <T>(raw: string): ApiResponse<T> => JSON.parse(raw) as ApiResponse<T>;

const REMOTE_KEY = { updated_at_ms: 2000, lww_counter: 0, device_id: 'device-peer' };

function payload(name: string, updatedAtMs: number, counter = 0): SongSyncPayload {
  return {
    name,
    artist: '手',
    source_url: null,
    source_provider: null,
    source_key: null,
    lyrics_offset: 0,
    duration: 0,
    created_at_ms: 1000,
    updated_at_ms: updatedAtMs,
    lww_counter: counter,
  };
}

/** A song holding the remote winner's values, plus the receipt that says so. */
function seedConflict(): { songId: string; conflictId: string } {
  const songId = randomUUID();
  ctx.sqlite
    .prepare(
      `INSERT INTO songs (id, name, artist, file_origin, created_at, updated_at, lww_counter, device_id)
       VALUES (?, '远端的名字', '手', 'downloaded', 1000, 2000, 0, 'device-peer')`,
    )
    .run(songId);
  const conflictId = recordConflict(ctx.sqlite, {
    entityType: 'song',
    entityId: songId,
    remoteSeq: 42,
    local: {
      payload: payload('本地的名字', 1500),
      key: { updated_at_ms: 1500, lww_counter: 0, device_id: 'device-mine' },
    },
    remote: { payload: payload('远端的名字', 2000), key: REMOTE_KEY },
  });
  return { songId, conflictId };
}

const nameOf = (songId: string): string =>
  (ctx.sqlite.prepare('SELECT name FROM songs WHERE id = ?').get(songId) as { name: string }).name;

describe('reading conflicts', () => {
  it('is empty on a library that never synced', async () => {
    expect(bodyOf<ConflictListData>((await get(API_PATHS.conflicts)).body).data?.conflicts).toEqual(
      [],
    );
    expect(bodyOf<ConflictCountData>((await get(API_PATHS.conflictsCount)).body).data).toEqual({
      count: 0,
    });
  });

  it('lists both versions and the keys that decided between them', async () => {
    const { songId } = seedConflict();

    const res = await get(API_PATHS.conflicts);
    const [conflict] = bodyOf<ConflictListData>(res.body).data?.conflicts ?? [];

    expect(conflict).toMatchObject({
      entity_type: 'song',
      entity_id: songId,
      remote_seq: 42,
      local_key: { updated_at_ms: 1500, device_id: 'device-mine' },
      remote_key: REMOTE_KEY,
    });
    expect(conflict?.local_payload?.name).toBe('本地的名字');
    expect(conflict?.remote_payload?.name).toBe('远端的名字');
  });

  it('serves one record on its own', async () => {
    const { conflictId } = seedConflict();
    const res = await get(apiPath.conflict(conflictId));
    expect(bodyOf<ConflictData>(res.body).data?.id).toBe(conflictId);
  });

  it('answers 404 for an id nobody recorded', async () => {
    const res = await get(apiPath.conflict(randomUUID()));
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res.body).error_code).toBe('CONFLICT_NOT_FOUND');
  });
});

describe('resolving', () => {
  it('keeps the remote version by filing the receipt and nothing else', async () => {
    const { songId, conflictId } = seedConflict();

    const res = await post(apiPath.conflictResolve(conflictId), {
      strategy: 'remote',
      expected_current: REMOTE_KEY,
    });

    expect(res.statusCode).toBe(200);
    expect(nameOf(songId)).toBe('远端的名字');
    expect(events.map((e) => e.type)).toEqual(['conflicts:changed']);
    expect(bodyOf<ConflictCountData>((await get(API_PATHS.conflictsCount)).body).data).toEqual({
      count: 0,
    });
  });

  it('puts the local version back through the ordinary write path', async () => {
    const { songId, conflictId } = seedConflict();

    const res = await post(apiPath.conflictResolve(conflictId), {
      strategy: 'local',
      expected_current: REMOTE_KEY,
    });

    expect(res.statusCode).toBe(200);
    expect(nameOf(songId)).toBe('本地的名字');
    // Published like any other edit, and the library on screen has to hear it.
    expect(events.map((e) => e.type)).toEqual(['songs:changed', 'conflicts:changed']);
    const emitted = ctx.sqlite
      .prepare("SELECT count(*) AS n FROM sync_changes WHERE op = 'update' AND entity_id = ?")
      .get(songId) as { n: number };
    expect(emitted.n).toBe(1);
  });

  it('refuses when the row moved on since the conflict was recorded', async () => {
    const { songId, conflictId } = seedConflict();
    // A third device wrote again while the user was deciding.
    ctx.sqlite
      .prepare("UPDATE songs SET name = '第三台设备', updated_at = 3000 WHERE id = ?")
      .run(songId);

    const res = await post(apiPath.conflictResolve(conflictId), {
      strategy: 'local',
      expected_current: REMOTE_KEY,
    });

    expect(res.statusCode).toBe(409);
    expect(bodyOf(res.body).error_code).toBe('CONFLICT_VERSION_MISMATCH');
    // The change nobody saw is still there.
    expect(nameOf(songId)).toBe('第三台设备');
  });

  it('refuses a second answer to the same conflict', async () => {
    const { conflictId } = seedConflict();
    const body = { strategy: 'remote', expected_current: REMOTE_KEY };

    expect((await post(apiPath.conflictResolve(conflictId), body)).statusCode).toBe(200);
    const again = await post(apiPath.conflictResolve(conflictId), body);

    expect(again.statusCode).toBe(409);
    expect(bodyOf(again.body).error_code).toBe('CONFLICT_VERSION_MISMATCH');
  });

  it('refuses a strategy it does not know, and a missing CAS token', async () => {
    const { conflictId } = seedConflict();

    const bad = await post(apiPath.conflictResolve(conflictId), {
      strategy: 'merge',
      expected_current: REMOTE_KEY,
    });
    const missing = await post(apiPath.conflictResolve(conflictId), { strategy: 'remote' });

    expect(bad.statusCode).toBe(400);
    expect(bodyOf(bad.body).error_code).toBe('INVALID_BODY');
    expect(missing.statusCode).toBe(400);
  });

  it('rejects an id that is not a uuid before it reaches the database', async () => {
    const res = await post('/conflicts/not-a-uuid/resolve', {
      strategy: 'remote',
      expected_current: REMOTE_KEY,
    });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res.body).error_code).toBe('INVALID_ID');
  });
});
