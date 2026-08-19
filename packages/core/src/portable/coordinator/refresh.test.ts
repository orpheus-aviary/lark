import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncLoginRequest } from '@lark/shared';
import { ApiError } from '@orpheus-aviary/skybridge-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSkybridgeCredentials } from '../../config/skybridge.js';
import {
  type CoordinatorHarness,
  type FakeSkybridge,
  createCoordinatorHarness,
  createFakeSkybridge,
} from '../../testing/index.js';
import { performSyncLogin } from './login.js';
import { performSyncLogout } from './logout.js';
import { REFRESH_MARGIN_MS, refreshSessionToken, tokenNeedsRefresh } from './refresh.js';

let nest: string;
let ctx: CoordinatorHarness;
let fake: FakeSkybridge;

const SERVER_TIME = 1_700_000_000_000;
const EXPIRES_AT = SERVER_TIME + 3_600_000;

const request: SyncLoginRequest = {
  server_url: 'https://sync.example.test',
  email: 'someone@example.test',
  password: 'correct horse',
};

beforeEach(async () => {
  nest = mkdtempSync(join(tmpdir(), 'lark-sync-refresh-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  mkdirSync(join(nest, 'lark'), { recursive: true });
  fake = createFakeSkybridge({ serverTimeMs: SERVER_TIME });
  ctx = createCoordinatorHarness({ api: fake.api });
  await performSyncLogin(ctx, request);
});

afterEach(() => {
  ctx.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

describe('tokenNeedsRefresh', () => {
  it('says no while the token has time left', () => {
    expect(tokenNeedsRefresh(ctx, EXPIRES_AT - REFRESH_MARGIN_MS - 1)).toBe(false);
  });

  it('says yes inside the margin', () => {
    expect(tokenNeedsRefresh(ctx, EXPIRES_AT - REFRESH_MARGIN_MS)).toBe(true);
  });

  it('says no without a session', async () => {
    await performSyncLogout(ctx);
    expect(tokenNeedsRefresh(ctx, EXPIRES_AT)).toBe(false);
  });
});

describe('refreshSessionToken', () => {
  it('lands the new token on disk and in the session', async () => {
    const before = ctx.sync.epoch;

    expect(await refreshSessionToken(ctx)).toBe(true);

    const credentials = readSkybridgeCredentials();
    expect(credentials?.auth?.token).toBe('token-refreshed');
    expect(credentials?.auth?.refresh_token).toBe('refresh-token-2');
    expect(ctx.sync.session).not.toBeNull();
    // A new session, so anything mid-round knows its client is the old one.
    expect(ctx.sync.epoch).toBeGreaterThan(before);
  });

  it('drops the session when the server says the refresh token is dead', async () => {
    fake.failAt('refresh', new ApiError('REFRESH_REPLAYED', 400, 'that token was rotated'));

    expect(await refreshSessionToken(ctx)).toBe(false);

    expect(ctx.sync.session).toBeNull();
    expect(ctx.sync.authReason).toBe('token_rejected');
    // The credentials stay: the user logs in again with a password, and the
    // file is what remembers which account and which device that is.
    expect(readSkybridgeCredentials()?.device?.id).not.toBeUndefined();
  });

  it('keeps the session when the failure is only a bad moment', async () => {
    fake.failAt('refresh', new Error('connect ECONNREFUSED'));

    expect(await refreshSessionToken(ctx)).toBe(false);

    expect(ctx.sync.session).not.toBeNull();
    expect(readSkybridgeCredentials()?.auth?.token).toBe('token-for-someone@example.test');
  });

  it('recovers a session a round dropped for a 401 while it was in flight', async () => {
    const { entered, release } = gatedRefresh();

    const inFlight = refreshSessionToken(ctx);
    await entered;
    // What a round does when the server refuses the old token. It is NOT
    // behind the lifecycle mutex — the round would be waiting for itself —
    // so this is the one thing that really can land mid-refresh.
    ctx.sync.dropSession('token_rejected');
    release();

    expect(await inFlight).toBe(true);
    // The refreshed token is exactly what fixes that 401, so it is installed
    // rather than discarded: sending the user to a password prompt with a
    // working refresh token in hand would be the wrong recovery.
    expect(ctx.sync.session).not.toBeNull();
    expect(ctx.sync.state).toBe('idle');
    expect(readSkybridgeCredentials()?.auth?.token).toBe('token-late');
  });

  it('discards a token whose credentials went away underneath it', async () => {
    const { entered, release } = gatedRefresh();

    const inFlight = refreshSessionToken(ctx);
    await entered;
    // A logout queues BEHIND the refresh (both take the lifecycle mutex), so
    // the file is emptied by hand here to stand in for the sequence that ends
    // with credentials describing nothing.
    ctx.sync.dropSession('missing_session');
    rmSync(join(nest, 'lark', 'skybridge.toml'));
    release();

    expect(await inFlight).toBe(false);
    expect(readSkybridgeCredentials()).toBeNull();
    expect(ctx.sync.session).toBeNull();
  });

  it('serializes a logout behind the refresh instead of interleaving', async () => {
    const { entered, release } = gatedRefresh();

    const inFlight = refreshSessionToken(ctx);
    await entered;
    const loggedOut = performSyncLogout(ctx);
    release();

    expect(await inFlight).toBe(true);
    await loggedOut;
    // The logout ran second and had the last word.
    expect(readSkybridgeCredentials()?.auth).toBeUndefined();
    expect(ctx.sync.session).toBeNull();
  });
});

/**
 * A refresh that does not return until the test says so, and that announces
 * when it has STARTED.
 *
 * The second half matters: `lifecycle` schedules its body on a microtask, so a
 * test that drops the session on the next line would land before the exchange
 * even began — and would be testing the mutex rather than the window it is
 * trying to describe.
 */
function gatedRefresh(): { entered: Promise<void>; release: () => void } {
  let release = (): void => {};
  let entered = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  ctx.api.refresh = async () => {
    entered();
    await gate;
    return { token: 'token-late', refreshToken: 'refresh-late', expiresAt: EXPIRES_AT };
  };
  return { entered: started, release };
}
