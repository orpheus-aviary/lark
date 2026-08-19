import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueWriteLyrics } from '@lark/core';
import { type FakeSkybridge, createFakeSkybridge } from '@lark/core/testing';
import {
  API_PATHS,
  type ApiResponse,
  type SyncDevicesData,
  type SyncFileOpsData,
  type SyncLoginResultData,
  type SyncRunResultData,
  type SyncStatusData,
} from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type TestApp,
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';

let nest: string;
let ctx: TestContext;
let app: TestApp;
let fake: FakeSkybridge;

const PASSWORD = 'hunter2-correct-horse';
const login = {
  server_url: 'https://sync.example.test',
  email: 'someone@example.test',
  password: PASSWORD,
};

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-route-sync-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  mkdirSync(join(nest, 'lark'), { recursive: true });
  fake = createFakeSkybridge();
  ctx = createTestContext({ skybridge: fake.api });
  app = buildTestServer(ctx);
});

afterEach(async () => {
  await closeTestContext(ctx);
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

/**
 * `app.inject` returns an intersection that includes `void`, so a helper
 * wrapping it has to declare what it gives back — otherwise `await` does not
 * narrow and `.statusCode` is a build error (M3 lesson).
 */
interface Injected {
  statusCode: number;
  body: string;
}

const post = async (url: string, payload?: Record<string, unknown>): Promise<Injected> => {
  const res = await app.inject({
    method: 'POST',
    url,
    ...(payload === undefined ? {} : { payload }),
  });
  return { statusCode: res.statusCode, body: res.body };
};
const get = async (url: string): Promise<Injected> => {
  const res = await app.inject({ method: 'GET', url });
  return { statusCode: res.statusCode, body: res.body };
};
const bodyOf = <T>(raw: string): ApiResponse<T> => JSON.parse(raw) as ApiResponse<T>;

describe('POST /sync/login', () => {
  it('installs the session and answers with what was adopted', async () => {
    const res = await post(API_PATHS.syncLogin, login);

    expect(res.statusCode).toBe(200);
    const body = bodyOf<SyncLoginResultData>(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      server_url: 'https://sync.example.test',
      user_id: 'user-1',
      workspace_id: 'workspace-1',
      device_reused: false,
      device_stamp: 'first-registration',
    });
    expect(ctx.sync.session).not.toBeNull();
  });

  it('never echoes the password or a token back', async () => {
    const res = await post(API_PATHS.syncLogin, login);
    expect(res.body).not.toContain(PASSWORD);
    expect(res.body).not.toContain('token-for-');
  });

  it('never writes the password or a token to the log', async () => {
    await post(API_PATHS.syncLogin, login);
    const logged = JSON.stringify(ctx.logger.records);
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain('token-for-');
  });

  it('refuses plaintext http with a 400 the caller can act on', async () => {
    const res = await post(API_PATHS.syncLogin, {
      ...login,
      server_url: 'http://sync.example.test',
    });

    expect(res.statusCode).toBe(400);
    expect(bodyOf(res.body).error_code).toBe('SYNC_INSECURE_URL');
  });

  it('reports a rejected password as 503, never as 401', async () => {
    // 401 is the daemon's own bearer token. A client that saw it here would
    // tell the user their DAEMON token was wrong.
    const res = await post(API_PATHS.syncLogin, { ...login, password: 'wrong' });

    expect(res.statusCode).toBe(503);
    expect(bodyOf(res.body).error_code).toBe('SYNC_AUTH_REQUIRED');
  });

  it('refuses a body with a field it does not know', async () => {
    const res = await post(API_PATHS.syncLogin, { ...login, remember_me: true });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res.body).error_code).toBe('INVALID_BODY');
  });

  it('refuses a second workspace on a bound library', async () => {
    await post(API_PATHS.syncLogin, login);
    const other = createFakeSkybridge({ workspaceId: 'workspace-2' });
    ctx.skybridge.createClient = other.api.createClient;

    const res = await post(API_PATHS.syncLogin, login);

    expect(res.statusCode).toBe(409);
    expect(bodyOf(res.body).error_code).toBe('SYNC_BINDING_MISMATCH');
  });
});

describe('GET /sync/status', () => {
  it('answers on an install that has never logged in', async () => {
    const res = await get(API_PATHS.syncStatus);

    expect(res.statusCode).toBe(200);
    expect(bodyOf<SyncStatusData>(res.body).data).toMatchObject({
      configured: false,
      authenticated: false,
      bound: false,
      state: 'auth_required',
      auth_reason: 'missing_session',
    });
  });

  it('reports the session once there is one', async () => {
    await post(API_PATHS.syncLogin, login);
    const res = await get(API_PATHS.syncStatus);

    expect(bodyOf<SyncStatusData>(res.body).data).toMatchObject({
      configured: true,
      authenticated: true,
      bound: true,
      state: 'idle',
    });
  });
});

describe('POST /sync/run', () => {
  it('needs a session', async () => {
    const res = await post(API_PATHS.syncRun);
    expect(res.statusCode).toBe(503);
    expect(bodyOf(res.body).error_code).toBe('SYNC_AUTH_REQUIRED');
  });

  it('runs a round and reports what moved', async () => {
    await post(API_PATHS.syncLogin, login);

    const res = await post(API_PATHS.syncRun);

    expect(res.statusCode).toBe(200);
    expect(bodyOf<SyncRunResultData>(res.body).data).toMatchObject({
      pulled: 0,
      pushed: 0,
      applied: 0,
      cancelled: false,
    });
    expect(fake.count('pull')).toBe(1);
  });
});

describe('devices', () => {
  it('lists them and marks the one this daemon is', async () => {
    const loggedIn = await post(API_PATHS.syncLogin, login);
    const deviceId = bodyOf<SyncLoginResultData>(loggedIn.body).data?.device_id;

    const res = await get(API_PATHS.syncDevices);

    const devices = bodyOf<SyncDevicesData>(res.body).data?.devices ?? [];
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ id: deviceId, is_current: true });
  });

  it('revokes one by id', async () => {
    await post(API_PATHS.syncLogin, login);

    const res = await post(API_PATHS.syncRevokeDevice, { device_id: 'device-other' });

    expect(res.statusCode).toBe(200);
    expect(fake.calls).toContain('revokeDevice:device-other');
  });

  it('needs a session to talk about devices at all', async () => {
    expect((await get(API_PATHS.syncDevices)).statusCode).toBe(503);
    expect((await post(API_PATHS.syncRevokeDevice, { device_id: 'x' })).statusCode).toBe(503);
  });
});

describe('the file-effect journal', () => {
  beforeEach(() => {
    enqueueWriteLyrics(ctx.sqlite, randomUUID(), '[00:00.00] 一句歌词');
  });

  it('reports an op that carries lyrics as a size and a digest, never as text', async () => {
    const res = await get(API_PATHS.syncFileOps);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('一句歌词');
    const [op] = bodyOf<SyncFileOpsData>(res.body).data?.file_ops ?? [];
    expect(op).toMatchObject({ kind: 'write_lyrics', attempts: 0 });
    expect(op?.inline).toMatchObject({ size: expect.any(Number) as unknown as number });
    expect(op?.inline?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('filters by state', async () => {
    ctx.sqlite.prepare('UPDATE sync_file_ops SET attempts = 5').run();

    const failed = bodyOf<SyncFileOpsData>((await get('/sync/file-ops?state=failed')).body);
    const pending = bodyOf<SyncFileOpsData>((await get('/sync/file-ops?state=pending')).body);

    expect(failed.data?.file_ops).toHaveLength(1);
    expect(pending.data?.file_ops).toHaveLength(0);
  });

  it('refuses a state it does not know', async () => {
    const res = await get('/sync/file-ops?state=angry');
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res.body).error_code).toBe('INVALID_QUERY');
  });

  it('retries every failed op when given no id', async () => {
    ctx.sqlite.prepare('UPDATE sync_file_ops SET attempts = 5').run();

    const res = await post(API_PATHS.syncFileOpsRetry);

    expect(res.statusCode).toBe(200);
    // The retry reset the count and ran the op, which had no file to write to
    // and therefore succeeded — the row is gone.
    expect(
      (ctx.sqlite.prepare('SELECT count(*) AS n FROM sync_file_ops').get() as { n: number }).n,
    ).toBe(0);
  });

  it('refuses to discard an op that has not given up yet', async () => {
    const id = (ctx.sqlite.prepare('SELECT id FROM sync_file_ops').get() as { id: number }).id;

    const res = await post(API_PATHS.syncFileOpsDiscard, { id });

    expect(res.statusCode).toBe(409);
    expect(bodyOf(res.body).error_code).toBe('FILE_OP_BUSY');
  });

  it('discards a permanently failed op and keeps a record of it', async () => {
    ctx.sqlite.prepare('UPDATE sync_file_ops SET attempts = 5').run();
    const id = (ctx.sqlite.prepare('SELECT id FROM sync_file_ops').get() as { id: number }).id;

    const res = await post(API_PATHS.syncFileOpsDiscard, { id });

    expect(res.statusCode).toBe(200);
    const archived = ctx.sqlite
      .prepare("SELECT count(*) AS n FROM sync_dead_letters WHERE reason = 'file_op_discarded'")
      .get() as { n: number };
    expect(archived.n).toBe(1);
  });

  it('answers 404 for an id that is not there', async () => {
    const res = await post(API_PATHS.syncFileOpsDiscard, { id: 9999 });
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res.body).error_code).toBe('FILE_OP_NOT_FOUND');
  });

  it('refuses a discard with no id', async () => {
    const res = await post(API_PATHS.syncFileOpsDiscard, {});
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res.body).error_code).toBe('INVALID_BODY');
  });
});

describe('POST /sync/logout', () => {
  it('reports whether there was anything to log out of', async () => {
    expect(bodyOf((await post(API_PATHS.syncLogout)).body).data).toMatchObject({
      had_session: false,
    });

    await post(API_PATHS.syncLogin, login);
    const res = await post(API_PATHS.syncLogout);

    expect(bodyOf(res.body).data).toMatchObject({ had_session: true, revoked_remotely: true });
    expect(ctx.sync.session).toBeNull();
  });
});
