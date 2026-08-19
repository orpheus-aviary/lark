import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncLoginRequest } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSkybridgeCredentials } from '../../config/skybridge.js';
import {
  type CoordinatorHarness,
  type FakeSkybridge,
  createCoordinatorHarness,
  createFakeSkybridge,
} from '../../testing/index.js';
import { readBinding } from '../sync/binding.js';
import { readSkybridgeDeviceId } from '../sync/device.js';
import { performSyncLogin } from './login.js';
import { performSyncLogout } from './logout.js';
import { restoreSession } from './session.js';

let nest: string;
let ctx: CoordinatorHarness;
let fake: FakeSkybridge;

const request: SyncLoginRequest = {
  server_url: 'https://sync.example.test',
  email: 'someone@example.test',
  password: 'correct horse',
};

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-sync-logout-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  mkdirSync(join(nest, 'lark'), { recursive: true });
  fake = createFakeSkybridge();
  ctx = createCoordinatorHarness({ api: fake.api });
});

afterEach(() => {
  ctx.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

describe('performSyncLogout', () => {
  it('drops the session and the token, keeping everything a re-login needs', async () => {
    const login = await performSyncLogin(ctx, request);

    const result = await performSyncLogout(ctx);

    expect(result).toEqual({ had_session: true, revoked_remotely: true });
    expect(ctx.sync.session).toBeNull();
    expect(ctx.sync.state).toBe('auth_required');
    expect(ctx.sync.authReason).toBe('missing_session');

    const credentials = readSkybridgeCredentials();
    expect(credentials?.auth).toBeUndefined();
    // The registration, the workspace and the binding survive: logging back in
    // continues where this left off instead of minting a second device.
    expect(credentials?.device?.id).toBe(login.device_id);
    expect(credentials?.workspace?.id).toBe('workspace-1');
    expect(readSkybridgeDeviceId(ctx.sqlite)).toBe(login.device_id);
    expect(readBinding(ctx.sqlite)).not.toBeNull();
  });

  it('is local-first: an unreachable server does not keep this device logged in', async () => {
    await performSyncLogin(ctx, request);
    fake.failAt('logout');

    const result = await performSyncLogout(ctx);

    expect(result).toEqual({ had_session: true, revoked_remotely: false });
    expect(ctx.sync.session).toBeNull();
    expect(readSkybridgeCredentials()?.auth).toBeUndefined();
  });

  it('is a no-op without a session', async () => {
    const result = await performSyncLogout(ctx);
    expect(result).toEqual({ had_session: false, revoked_remotely: false });
    expect(fake.count('logout')).toBe(0);
  });

  it('bumps the epoch, so anything mid-round knows its session is gone', async () => {
    await performSyncLogin(ctx, request);
    const epoch = ctx.sync.epoch;

    await performSyncLogout(ctx);

    expect(ctx.sync.isStale(epoch)).toBe(true);
  });

  it('leaves a restore with nothing to install', async () => {
    await performSyncLogin(ctx, request);
    await performSyncLogout(ctx);

    // What a restart would do: credentials without [auth] are "log in again",
    // not "broken".
    expect(restoreSession(ctx)).toEqual({ installed: false, reason: 'credentials_missing' });
    expect(ctx.sync.session).toBeNull();
  });

  it('logging back in restores the same device and workspace', async () => {
    const first = await performSyncLogin(ctx, request);
    await performSyncLogout(ctx);

    const second = await performSyncLogin(ctx, request);

    expect(second.device_id).toBe(first.device_id);
    expect(second.device_reused).toBe(true);
    expect(second.backfill).toBeNull();
    expect(ctx.sync.session).not.toBeNull();
  });
});

describe('restoreSession', () => {
  it('rebuilds a session from disk without touching the network', async () => {
    const login = await performSyncLogin(ctx, request);
    // Simulate a restart: the runtime forgets, the disk does not.
    await ctx.sync.teardownSession();
    fake.calls.length = 0;

    const outcome = restoreSession(ctx);

    expect(outcome).toEqual({ installed: true });
    expect(ctx.sync.session?.deviceId).toBe(login.device_id);
    expect(ctx.sync.state).toBe('idle');
    // Building a client is local; nothing was asked of the server.
    expect(fake.calls).toEqual([`createClient:${login.device_id}`]);
  });

  it('reports a fresh install as missing, not broken', () => {
    expect(restoreSession(ctx)).toEqual({ installed: false, reason: 'missing_session' });
    expect(ctx.sync.state).toBe('auth_required');
  });

  it('refuses credentials that name another workspace than the binding', async () => {
    await performSyncLogin(ctx, request);
    await ctx.sync.teardownSession();
    ctx.sqlite.prepare("UPDATE sync_binding SET workspace_id = 'workspace-elsewhere'").run();

    const outcome = restoreSession(ctx);

    expect(outcome.installed).toBe(false);
    expect(ctx.sync.state).toBe('error');
    expect(ctx.sync.lastError).toMatch(/workspace-elsewhere/);
  });
});
