import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SyncBindingMismatchError,
  SyncInsecureUrlError,
  SyncSchemaVersionMismatchError,
  paths,
  readBinding,
  readSkybridgeCredentials,
  readSkybridgeDeviceId,
} from '@lark/core';
import type { SyncLoginRequest } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type TestContext,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';
import { type FakeSkybridge, createFakeSkybridge, makeDevice } from '../testing/fake-skybridge.js';
import { performSyncLogin } from './login.js';

let nest: string;
let ctx: TestContext;
let fake: FakeSkybridge;

const request: SyncLoginRequest = {
  server_url: 'https://sync.example.test/',
  email: 'someone@example.test',
  password: 'correct horse',
};

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-sync-login-'));
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

/** A library that predates sync, so the backfill has something to publish. */
function seedPreSyncSong(): string {
  const id = randomUUID();
  ctx.sqlite
    .prepare(
      `INSERT INTO songs (id, name, artist, source_provider, source_key, file_origin,
         created_at, updated_at, lww_counter)
       VALUES (?, '旧歌', '旧手', 'bilibili', 'BVold:1', 'imported', 1000, 1000, 0)`,
    )
    .run(id);
  return id;
}

describe('first login', () => {
  it('binds, registers, back-fills and installs the session in one go', async () => {
    const songId = seedPreSyncSong();

    const result = await performSyncLogin(ctx, request);

    expect(result.workspace_id).toBe('workspace-1');
    expect(result.device_reused).toBe(false);
    // The trailing slash is gone: one server, one spelling.
    expect(result.server_url).toBe('https://sync.example.test');

    expect(readBinding(ctx.sqlite)).toMatchObject({
      server_id: 'server-1',
      user_id: 'user-1',
      workspace_id: 'workspace-1',
      schema_version: 1,
    });
    expect(readSkybridgeDeviceId(ctx.sqlite)).toBe(result.device_id);
    expect(ctx.sync.session?.workspaceId).toBe('workspace-1');
    expect(ctx.sync.state).toBe('idle');

    // The pre-sync song now has a create op and carries the registered id.
    expect(result.backfill?.songs).toBe(1);
    const row = ctx.sqlite.prepare('SELECT device_id FROM songs WHERE id = ?').get(songId) as {
      device_id: string | null;
    };
    expect(row.device_id).toBe(result.device_id);
    expect(result.device_stamp?.mode).toBe('first-registration');
    expect(result.rebase).not.toBeNull();
  });

  it('writes the credential file at 0600 with the device and workspace', async () => {
    const result = await performSyncLogin(ctx, request);

    expect(statSync(paths.skybridgeConfigPath()).mode & 0o777).toBe(0o600);
    expect(readSkybridgeCredentials()).toEqual({
      server: { url: 'https://sync.example.test' },
      auth: {
        user_id: 'user-1',
        email: 'someone@example.test',
        token: 'token-for-someone@example.test',
        refresh_token: 'refresh-token',
        expires_at: expect.any(Number) as unknown as number,
      },
      device: { id: result.device_id, name: expect.any(String) as unknown as string },
      workspace: { id: 'workspace-1' },
    });
  });

  it('refuses a plaintext server before a password is sent anywhere', async () => {
    await expect(
      performSyncLogin(ctx, { ...request, server_url: 'http://sync.example.test' }),
    ).rejects.toThrow(SyncInsecureUrlError);
    expect(fake.calls).toEqual([]);
  });

  it('takes the breaker when it is explicitly set', async () => {
    await performSyncLogin(ctx, {
      ...request,
      server_url: 'http://sync.example.test',
      allow_insecure_http: true,
    });
    expect(readSkybridgeCredentials()?.server.allow_insecure_http).toBe(true);
  });
});

describe('re-login', () => {
  it('reuses the device and republishes nothing', async () => {
    const first = await performSyncLogin(ctx, request);
    fake.calls.length = 0;

    const second = await performSyncLogin(ctx, request);

    expect(second.device_id).toBe(first.device_id);
    expect(second.device_reused).toBe(true);
    expect(fake.count('registerDevice')).toBe(0);
    // An ordinary re-login owes the workspace nothing: no backfill, no rebase.
    expect(second.backfill).toBeNull();
    expect(second.rebase).toBeNull();
    expect(fake.count('serverTime')).toBe(0);
  });

  it('registers again when the stored device was revoked', async () => {
    const first = await performSyncLogin(ctx, request);
    const revoked = fake.devices.get(first.device_id);
    if (revoked === undefined) expect.unreachable('the device should exist');
    fake.devices.set(first.device_id, { ...revoked, revokedAt: 1_700_000_000_000 });

    const second = await performSyncLogin(ctx, request);

    expect(second.device_reused).toBe(false);
    expect(second.device_id).not.toBe(first.device_id);
    // Rows with unpushed work follow the new identity; published rows do not.
    expect(second.device_stamp?.mode).toBe('device-changed');
  });
});

describe('refusals', () => {
  it('refuses a second account on a bound library, and lets go of its token', async () => {
    await performSyncLogin(ctx, request);
    fake.calls.length = 0;

    const other = createFakeSkybridge({ userId: 'user-2' });
    ctx.sync.api.login = other.api.login;

    await expect(performSyncLogin(ctx, request)).rejects.toThrow(SyncBindingMismatchError);
    // Nothing was registered this round, so nothing is revoked — but the token
    // this attempt obtained must not be left alive.
    expect(fake.count('revokeDevice')).toBe(0);
    expect(fake.count('logout')).toBe(1);
    // The session that was already running is untouched.
    expect(ctx.sync.session).not.toBeNull();
  });

  it('refuses a workspace that speaks another schema version', async () => {
    fake.workspace = { ...fake.workspace, schemaVersion: 2 };

    await expect(performSyncLogin(ctx, request)).rejects.toThrow(SyncSchemaVersionMismatchError);
    expect(readBinding(ctx.sqlite)).toBeNull();
    expect(readSkybridgeCredentials()).toBeNull();
  });

  it('compensates in the frozen order: revoke the new device, then log out', async () => {
    fake.failAt('ensureWorkspace');

    await expect(performSyncLogin(ctx, request)).rejects.toThrow();

    const compensation = fake.calls.filter(
      (call) => call.startsWith('revokeDevice') || call === 'logout',
    );
    expect(compensation).toEqual([`revokeDevice:${[...fake.devices.keys()][0]}`, 'logout']);
  });

  it('never revokes a device it merely reused', async () => {
    const first = await performSyncLogin(ctx, request);
    fake.calls.length = 0;
    fake.failAt('ensureWorkspace');

    await expect(performSyncLogin(ctx, request)).rejects.toThrow();

    // Revoking here would log the user's OTHER machine out because this one
    // failed to log in.
    expect(fake.count('revokeDevice')).toBe(0);
    expect(fake.count('logout')).toBe(1);
    expect(fake.devices.get(first.device_id)?.revokedAt).toBeNull();
  });

  it('rolls the credential file back when the session cannot be installed', async () => {
    await performSyncLogin(ctx, request);
    const before = readSkybridgeCredentials();
    fake.calls.length = 0;
    // The third createClient of a round is the one that builds the session —
    // after the transaction committed and the new toml was written.
    fake.failCreateClientOnCall(3);

    await expect(performSyncLogin(ctx, request)).rejects.toThrow(/fell over/);

    expect(readSkybridgeCredentials()).toEqual(before);
    // And the session that was dropped before the transaction is back.
    expect(ctx.sync.session?.workspaceId).toBe('workspace-1');
    expect(ctx.sync.state).toBe('idle');
  });

  it('reports a rejected password without touching local state', async () => {
    await expect(performSyncLogin(ctx, { ...request, password: 'wrong' })).rejects.toThrow(
      /refused/,
    );
    expect(readBinding(ctx.sqlite)).toBeNull();
    expect(ctx.sync.state).toBe('auth_required');
    // Nothing to compensate: the login itself is what failed.
    expect(fake.count('logout')).toBe(0);
  });
});

describe('lifecycle', () => {
  it('serializes concurrent logins instead of interleaving them', async () => {
    const [a, b] = await Promise.all([
      performSyncLogin(ctx, request),
      performSyncLogin(ctx, request),
    ]);

    expect(a.workspace_id).toBe(b.workspace_id);
    // One device, registered once: the second login found the first one's.
    expect(fake.count('registerDevice')).toBe(1);
    expect(a.device_id).toBe(b.device_id);
    // Two installs, two epochs — a round that captured the first is stale.
    expect(ctx.sync.epoch).toBeGreaterThanOrEqual(2);
  });

  it('adopts an existing registration on a fresh library', async () => {
    // The device row is on the account (a previous install), but this library
    // has never bound: the id must be reused, not duplicated.
    fake.devices.set('device-old', makeDevice('device-old'));
    ctx.sqlite
      .prepare(
        "INSERT INTO local_metadata (key, value) VALUES ('skybridge_device_id', 'device-old')",
      )
      .run();

    const result = await performSyncLogin(ctx, request);

    expect(result.device_id).toBe('device-old');
    expect(result.device_reused).toBe(true);
    expect(fake.count('registerDevice')).toBe(0);
  });
});
