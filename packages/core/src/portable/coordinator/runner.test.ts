import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LarkEvent, SyncLoginRequest } from '@lark/shared';
import { ApiError } from '@orpheus-aviary/skybridge-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CoordinatorHarness,
  type FakeSkybridge,
  createCoordinatorHarness,
  createFakeSkybridge,
  remoteSongCreate,
} from '../../testing/index.js';
import { SyncAuthRequiredError } from '../errors.js';
import { performSyncLogin } from './login.js';
import { runSyncRound } from './runner.js';

let nest: string;
let ctx: CoordinatorHarness;
let fake: FakeSkybridge;
let events: LarkEvent[];

const request: SyncLoginRequest = {
  server_url: 'https://sync.example.test',
  email: 'someone@example.test',
  password: 'correct horse',
};

beforeEach(async () => {
  nest = mkdtempSync(join(tmpdir(), 'lark-sync-runner-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  mkdirSync(join(nest, 'lark'), { recursive: true });
  fake = createFakeSkybridge();
  ctx = createCoordinatorHarness({ api: fake.api });
  events = ctx.events.emitted;
  await performSyncLogin(ctx, request);
  events.length = 0;
});

afterEach(() => {
  ctx.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

const round = () =>
  runSyncRound(ctx, { triggers: ['manual'], signal: new AbortController().signal });
const typesOf = (): string[] => events.map((event) => event.type);

describe('a successful round', () => {
  it('reports idle with a timestamp, and says so twice', async () => {
    const result = await round();

    expect(result.cancelled).toBe(false);
    expect(ctx.sync.state).toBe('idle');
    expect(ctx.sync.lastSyncAt).not.toBeNull();
    // Once entering `syncing`, once landing back on `idle`.
    expect(typesOf().filter((type) => type === 'sync:status_changed')).toHaveLength(2);
  });

  it('tells the front-ends what a pull changed', async () => {
    fake.queuePull([remoteSongCreate({ serverSeq: 1, songId: randomUUID() })]);

    const result = await round();

    expect(result.applied).toBe(1);
    expect(typesOf()).toContain('songs:changed');
  });

  it('says nothing about the library when a pull changed nothing', async () => {
    await round();
    expect(typesOf()).not.toContain('songs:changed');
  });

  it('pushes what the library owes and marks it settled', async () => {
    ctx.sqlite
      .prepare(
        `INSERT INTO songs (id, name, artist, file_origin, created_at, updated_at, lww_counter)
         VALUES (?, 'n', 'a', 'downloaded', 1, 1, 0)`,
      )
      .run(randomUUID());
    // A change the library emitted but has not published.
    ctx.sqlite
      .prepare(
        `INSERT INTO sync_changes (device_id, entity_type, entity_id, op, payload, created_at, client_change_id)
         VALUES ('local', 'song', ?, 'create', '{}', 1, ?)`,
      )
      .run(randomUUID(), randomUUID());

    const result = await round();

    expect(result.pushed).toBe(1);
    expect(fake.pushed).toHaveLength(1);
    const pending = ctx.sqlite
      .prepare('SELECT count(*) AS n FROM sync_changes WHERE synced_at IS NULL')
      .get() as { n: number };
    expect(pending.n).toBe(0);
  });
});

describe('a failing round', () => {
  it('drops the session when the token is refused — without waiting for itself', async () => {
    fake.failAt('pull', new ApiError('TOKEN_INVALID', 401, 'token rejected'));

    await expect(round()).rejects.toThrow();

    // The auth path must not call teardownSession: that waits for the round in
    // flight, which is this one. Reaching this line at all is the assertion.
    expect(ctx.sync.session).toBeNull();
    expect(ctx.sync.state).toBe('auth_required');
    expect(ctx.sync.authReason).toBe('token_rejected');
  });

  it('calls an unreachable server offline, not broken', async () => {
    fake.failAt('pull', new Error('connect ECONNREFUSED'));

    await expect(round()).rejects.toThrow();

    expect(ctx.sync.state).toBe('offline');
    expect(ctx.sync.session).not.toBeNull(); // still logged in, just unreachable
  });

  it('calls a rejected request an error', async () => {
    fake.failAt('pull', new ApiError('BAD_REQUEST', 400, 'nope'));

    await expect(round()).rejects.toThrow();

    expect(ctx.sync.state).toBe('error');
    expect(ctx.sync.lastError).toMatch(/nope/);
  });

  it('refuses to run at all without a session', async () => {
    await ctx.sync.teardownSession();
    await expect(round()).rejects.toThrow(SyncAuthRequiredError);
  });
});

describe('epoch', () => {
  it('does not report a result that belongs to a replaced session', async () => {
    ctx.sync.noteError('a state somebody else set');
    const inFlight = round();
    // A logout lands while the round is in flight.
    await ctx.sync.teardownSession();
    ctx.sync.noteAuthRequired('missing_session');

    await inFlight;

    expect(ctx.sync.state).toBe('auth_required');
    expect(ctx.sync.lastSyncAt).toBeNull();
  });
});

describe('retention', () => {
  it('trims settled changes, then leaves the outbox alone for an hour', async () => {
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const insert = ctx.sqlite.prepare(
      `INSERT INTO sync_changes (device_id, entity_type, entity_id, op, payload, created_at, client_change_id, synced_at, server_seq)
       VALUES ('local', 'song', ?, 'update', '{}', ?, ?, ?, 1)`,
    );
    insert.run(randomUUID(), old, randomUUID(), old);

    await round();
    expect(
      (ctx.sqlite.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n,
    ).toBe(0);

    insert.run(randomUUID(), old, randomUUID(), old);
    await round();
    // The second round is inside the hour, so the row survives — retention is
    // housekeeping the round happens to be a convenient moment for, not part
    // of the protocol.
    expect(
      (ctx.sqlite.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n,
    ).toBe(1);
  });
});
