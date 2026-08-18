import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countQuarantined, enqueueDeleteLyrics, recordDeadLetter } from '@lark/core';
import type { SyncLoginRequest } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type TestContext,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';
import { type FakeSkybridge, createFakeSkybridge } from '../testing/fake-skybridge.js';
import { performSyncLogin } from './login.js';
import { performSyncLogout } from './logout.js';
import { buildSyncStatus } from './status.js';

let nest: string;
let ctx: TestContext;
let fake: FakeSkybridge;

const request: SyncLoginRequest = {
  server_url: 'https://sync.example.test',
  email: 'someone@example.test',
  password: 'correct horse',
};

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-sync-status-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  mkdirSync(join(nest, 'lark'), { recursive: true });
  fake = createFakeSkybridge();
  ctx = createTestContext({ skybridge: fake.api });
});

afterEach(async () => {
  await closeTestContext(ctx);
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

function insertSong(key: string | null): string {
  const id = randomUUID();
  ctx.sqlite
    .prepare(
      `INSERT INTO songs (id, name, artist, source_provider, source_key, file_origin,
         created_at, updated_at, lww_counter)
       VALUES (?, 'n', 'a', ?, ?, 'downloaded', 1, 1, 0)`,
    )
    .run(id, key === null ? null : 'bilibili', key);
  return id;
}

describe('buildSyncStatus', () => {
  it('describes a fresh install as unconfigured rather than broken', () => {
    expect(buildSyncStatus(ctx, countQuarantined)).toMatchObject({
      configured: false,
      authenticated: false,
      bound: false,
      server_url: null,
      device_id: null,
      workspace_id: null,
      state: 'auth_required',
      auth_reason: 'missing_session',
      pending_count: 0,
      pulled_seq: 0,
      pushed_seq: 0,
      last_sync_at: null,
    });
  });

  it('reports the three "is it usable" answers separately after a login', async () => {
    const login = await performSyncLogin(ctx, request);

    expect(buildSyncStatus(ctx, countQuarantined)).toMatchObject({
      configured: true,
      authenticated: true,
      bound: true,
      server_url: 'https://sync.example.test',
      device_id: login.device_id,
      workspace_id: 'workspace-1',
      state: 'idle',
      auth_reason: null,
    });
  });

  it('keeps `configured` and `bound` after a logout — only the session went', async () => {
    await performSyncLogin(ctx, request);
    await performSyncLogout(ctx);

    expect(buildSyncStatus(ctx, countQuarantined)).toMatchObject({
      configured: true,
      authenticated: false,
      bound: true,
      state: 'auth_required',
      auth_reason: 'missing_session',
    });
  });

  it('reports the reason only while the state is auth_required', async () => {
    await performSyncLogin(ctx, request);
    ctx.sync.noteOffline('the server is not answering');

    expect(buildSyncStatus(ctx, countQuarantined)).toMatchObject({
      state: 'offline',
      auth_reason: null,
      last_error: 'the server is not answering',
    });
  });

  it('counts what survives a restart: dead letters, file ops, duplicates', async () => {
    await performSyncLogin(ctx, request);
    insertSong('BV1:1');
    insertSong('BV1:1'); // the D8 pair
    insertSong(null);
    recordDeadLetter(ctx.sqlite, { direction: 'in', reason: 'unknown_op', payload: '{}' });
    recordDeadLetter(ctx.sqlite, { direction: 'out', reason: 'change_too_large', payload: '{}' });
    enqueueDeleteLyrics(ctx.sqlite, randomUUID());

    expect(buildSyncStatus(ctx, countQuarantined)).toMatchObject({
      duplicate_source_keys: 2,
      dead_letters: { in: 1, out: 1 },
      pending_file_ops: 1,
      file_op_failures: 0,
      quarantined_count: 0,
      last_file_error: null,
    });
  });

  it('reads the cursor for the workspace this library is bound to', async () => {
    await performSyncLogin(ctx, request);
    ctx.sqlite
      .prepare(
        `INSERT INTO sync_cursor (server_id, workspace_id, pulled_seq, pushed_seq, updated_at)
         VALUES ('server-1', 'workspace-1', 12, 9, 1)
         ON CONFLICT(server_id, workspace_id) DO UPDATE SET pulled_seq = 12, pushed_seq = 9`,
      )
      .run();

    expect(buildSyncStatus(ctx, countQuarantined)).toMatchObject({ pulled_seq: 12, pushed_seq: 9 });
  });

  it('survives a credential file it cannot read', async () => {
    await performSyncLogin(ctx, request);
    await ctx.sync.teardownSession();
    // A hand-edited file: the status is where a user would learn about it, so
    // it must not be the thing that breaks.
    rmSync(join(nest, 'lark', 'skybridge.toml'));
    mkdirSync(join(nest, 'lark', 'skybridge.toml'));

    const status = buildSyncStatus(ctx, countQuarantined);

    expect(status.configured).toBe(false);
    expect(status.bound).toBe(true);
    expect(ctx.logger.records.some((line) => line.msg.includes('credential file'))).toBe(true);
  });
});
