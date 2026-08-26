// `lark sync …` (v0.2 T5): which call each command makes, what it refuses to
// do without being asked twice, and the one thing it must never print.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncFileOpSummary, SyncStatusData } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliError } from '../lib/errors.js';
import { captureStreams } from '../lib/output.js';
import { fakeContext } from '../testing/fake-backend.js';
import {
  assertFileOpsShape,
  assertLoginShape,
  runSyncConfigShow,
  runSyncFileOps,
  runSyncLogin,
  runSyncLogout,
  runSyncRun,
  runSyncStatus,
  runSyncUnbind,
} from './sync.js';

const SECRET = { promptSecret: () => Promise.resolve('hunter2'), isTty: true };

function syncStatus(overrides: Partial<SyncStatusData> = {}): SyncStatusData {
  return {
    configured: true,
    authenticated: true,
    bound: true,
    server_url: 'https://sync.example',
    device_id: 'dev-1',
    workspace_id: 'ws-1',
    pending_count: 2,
    pulled_seq: 41,
    pushed_seq: 39,
    last_sync_at: null,
    state: 'idle',
    auth_reason: null,
    last_error: null,
    dead_letters: { in: 0, out: 0 },
    duplicate_source_keys: 0,
    pending_file_ops: 0,
    file_op_failures: 0,
    quarantined_count: 0,
    last_file_error: null,
    ...overrides,
  };
}

function fileOp(overrides: Partial<SyncFileOpSummary> = {}): SyncFileOpSummary {
  return {
    id: 7,
    kind: 'write_lyrics',
    song_id: 'song-1',
    attempts: 5,
    last_error: 'EACCES',
    next_retry_at: null,
    created_at: 0,
    inline: null,
    ...overrides,
  };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as CliError).code;
  }
}

describe('sync status', () => {
  it('reports the state, the cursor and what is waiting for a person', async () => {
    const ctx = fakeContext({
      syncStatus: syncStatus({
        file_op_failures: 1,
        quarantined_count: 3,
        duplicate_source_keys: 2,
      }),
    });

    await runSyncStatus(ctx);

    const text = ctx.streams.stdout.join('\n');
    expect(text).toContain('状态：空闲');
    expect(text).toContain('待推送：2');
    expect(text).toContain('游标：已拉取 41 / 已推送 39');
    expect(text).toContain('永久失败 1');
    expect(text).toContain('已隔离：3');
    expect(text).toContain('来源重复：2');
  });

  it('names the reason when sync is waiting for a login', async () => {
    const ctx = fakeContext({
      syncStatus: syncStatus({ state: 'auth_required', auth_reason: 'token_rejected' }),
    });

    await runSyncStatus(ctx);

    expect(ctx.streams.stdout.join('\n')).toContain('需要登录（服务器拒绝了保存的凭证）');
  });
});

describe('sync login', () => {
  // Exit 2, not exit 4: an argument that cannot work is not a reason to send
  // the user off to start a daemon (M6).
  it('refuses a missing server or email before anything is probed', () => {
    expect(() => assertLoginShape({ email: 'a@b.com' })).toThrow(/--server/);
    expect(() => assertLoginShape({ server: 'https://x' })).toThrow(/--email/);
  });

  it('sends the form and never puts the password in the arguments', async () => {
    const ctx = fakeContext({
      syncLogin: {
        server_url: 'https://sync.example',
        user_id: 'u-1',
        email: 'me@example.com',
        device_id: 'dev-1',
        device_name: 'laptop',
        device_reused: false,
        workspace_id: 'ws-1',
        backfill: {
          songs: 20,
          playlists: 2,
          memberships: 4,
          lyrics: 18,
          lyrics_skipped: 0,
          lyrics_oversize: 1,
        },
        rebased_entities: 0,
        device_stamp: 'first-registration',
        local_workspace_id: 'local',
        local_workspace_created: false,
        restart_required: false,
      },
    });

    await runSyncLogin(ctx, { server: 'https://sync.example ', email: ' me@example.com' }, SECRET);

    expect(ctx.backend.argsOf('syncLogin')).toEqual([
      {
        server_url: 'https://sync.example',
        email: 'me@example.com',
        password: 'hunter2',
      },
    ]);
    const text = ctx.streams.stdout.join('\n');
    expect(text).toContain('已登录：me@example.com');
    expect(text).toContain('20 首歌 / 2 个歌单');
    expect(text).toContain('1 份歌词过大');
  });

  // §3.7: the flag says "I know", the confirmation says what it costs. In
  // --json mode the confirmation cannot be asked, so the login never happens.
  it('will not carry the plaintext breaker without a second act', async () => {
    const ctx = fakeContext({}, { yes: false, json: true });

    const code = await codeOf(() =>
      runSyncLogin(
        ctx,
        { server: 'http://sync.example', email: 'me@example.com', allowInsecureHttp: true },
        SECRET,
      ),
    );

    expect(code).toBe('USAGE_ERROR');
    expect(ctx.backend.names()).not.toContain('syncLogin');
  });

  it('carries the breaker once it has been confirmed', async () => {
    const ctx = fakeContext({}, { yes: true });

    await runSyncLogin(
      ctx,
      { server: 'http://sync.example', email: 'me@example.com', allowInsecureHttp: true },
      SECRET,
    );

    expect(ctx.backend.argsOf('syncLogin')?.[0]).toMatchObject({ allow_insecure_http: true });
  });

  // A password cannot be typed in a stream somebody is parsing.
  it('refuses to prompt in --json mode', async () => {
    const ctx = fakeContext({}, { json: true });

    const code = await codeOf(() =>
      runSyncLogin(ctx, { server: 'https://x', email: 'a@b.com' }, { isTty: true }),
    );

    expect(code).toBe('USAGE_ERROR');
  });

  it('reads the password from stdin when asked to', async () => {
    const ctx = fakeContext({}, { json: true });

    await runSyncLogin(
      ctx,
      { server: 'https://x', email: 'a@b.com', passwordStdin: true },
      { readStdin: () => Promise.resolve('from-a-pipe') },
    );

    expect(ctx.backend.argsOf('syncLogin')?.[0]).toMatchObject({ password: 'from-a-pipe' });
  });
});

describe('sync logout and run', () => {
  it('says what a logout keeps', async () => {
    const ctx = fakeContext({ syncLogout: { had_session: true, revoked_remotely: false } });

    await runSyncLogout(ctx);

    const text = ctx.streams.stdout.join('\n');
    expect(text).toContain('没能通知服务器');
    expect(text).toContain('绑定关系与未同步的变更都保留');
  });

  it('reports what a round moved', async () => {
    const ctx = fakeContext({
      syncRun: {
        pulled: 5,
        pushed: 2,
        applied: 4,
        skipped: 1,
        dead_lettered: 0,
        conflicts: 1,
        cancelled: false,
        pulled_seq: 46,
        pushed_seq: 41,
      },
    });

    await runSyncRun(ctx);

    const text = ctx.streams.stdout.join('\n');
    expect(text).toContain('拉取 5（应用 4，跳过 1），推送 2');
    expect(text).toContain('新增冲突 1 处');
  });
});

describe('sync file-ops', () => {
  it('rejects the two flags together and an unknown state', () => {
    expect(() => assertFileOpsShape({ retry: true, discard: '1' })).toThrow(/不能同时/);
    expect(() => assertFileOpsShape({ state: 'done' })).toThrow(/--state/);
  });

  it('lists what is stuck, with the error that stuck it', async () => {
    const ctx = fakeContext({ syncFileOps: [fileOp()] });

    await runSyncFileOps(ctx, { state: 'failed' });

    expect(ctx.backend.argsOf('syncFileOps')).toEqual(['failed']);
    expect(ctx.streams.stdout.join('\n')).toContain('#7 · write_lyrics');
    expect(ctx.streams.stdout.join('\n')).toContain('EACCES');
  });

  it('retries one row, or every failed row', async () => {
    const all = fakeContext({});
    await runSyncFileOps(all, { retry: true });
    expect(all.backend.argsOf('syncFileOpsRetry')).toEqual([undefined]);

    const one = fakeContext({});
    await runSyncFileOps(one, { retry: '7' });
    expect(one.backend.argsOf('syncFileOpsRetry')).toEqual([7]);
  });

  it('rejects a non-numeric id rather than sending it', async () => {
    const ctx = fakeContext({});

    expect(await codeOf(() => runSyncFileOps(ctx, { retry: 'seven' }))).toBe('USAGE_ERROR');
    expect(ctx.backend.names()).not.toContain('syncFileOpsRetry');
  });

  // Discard destroys a file effect for good, so the row is named first and
  // the question is asked before anything is sent.
  it('shows the row and asks before discarding it', async () => {
    const ctx = fakeContext({ syncFileOps: [fileOp()] });

    await runSyncFileOps(ctx, { discard: '7' });

    expect(ctx.streams.stderr.join('\n')).toContain('#7 · write_lyrics');
    expect(ctx.backend.argsOf('syncFileOpsDiscard')).toEqual([7]);
  });

  it('sends nothing when the confirmation cannot be asked', async () => {
    const ctx = fakeContext({ syncFileOps: [fileOp()] }, { yes: false, json: true });

    expect(await codeOf(() => runSyncFileOps(ctx, { discard: '7' }))).toBe('USAGE_ERROR');
    expect(ctx.backend.names()).not.toContain('syncFileOpsDiscard');
  });
});

const unbindResult = {
  changes: 3,
  tombstones: 1,
  dead_letters: 0,
  cursors: 1,
  discarded_changes: 0,
  discarded_deletes: 0,
  had_credentials: true,
  backfill_target: 2,
};

describe('sync unbind', () => {
  // R5-P1-3: a confirmation that cannot say how much is being thrown away is
  // not a confirmation.
  it('names the unpushed deletes BEFORE asking', async () => {
    const ctx = fakeContext({
      syncPending: { total: 4, unpublished_deletes: 2 },
      syncUnbind: unbindResult,
    });

    await runSyncUnbind(ctx, {});

    const asked = ctx.streams.stderr.join('\n');
    expect(asked).toContain('4 条未推送变更');
    expect(asked).toContain('2 条是删除');
    expect(ctx.backend.names().indexOf('syncPendingChanges')).toBeLessThan(
      ctx.backend.names().indexOf('syncUnbind'),
    );
  });

  it('passes --force through, and reports what it gave up', async () => {
    const ctx = fakeContext({
      syncPending: { total: 4, unpublished_deletes: 2 },
      syncUnbind: { ...unbindResult, discarded_changes: 4, discarded_deletes: 2 },
    });

    await runSyncUnbind(ctx, { force: true });

    expect(ctx.backend.argsOf('syncUnbind')).toEqual([{ force: true }]);
    expect(ctx.streams.stdout.join('\n')).toContain('已放弃 4 条未推送变更');
  });

  it('unbinds nothing when the confirmation cannot be asked', async () => {
    const ctx = fakeContext({ syncUnbind: unbindResult }, { yes: false, json: true });

    expect(await codeOf(() => runSyncUnbind(ctx, {}))).toBe('USAGE_ERROR');
    expect(ctx.backend.names()).not.toContain('syncUnbind');
  });
});

describe('sync config-show', () => {
  let nest: string;

  beforeEach(() => {
    nest = mkdtempSync(join(tmpdir(), 'lark-sync-cfg-'));
    mkdirSync(join(nest, 'lark'), { recursive: true });
    vi.stubEnv('LARK_NEST_DIR', nest);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(nest, { recursive: true, force: true });
  });

  it('says so plainly when sync was never configured', async () => {
    const streams = captureStreams();

    await runSyncConfigShow({ streams, json: false });

    expect(streams.stdout.join('\n')).toContain('还没有配置同步');
  });

  // The whole point of this command is to be readable while sync is broken —
  // and the token is the one thing it must never make readable.
  it('shows the account and the device, never the token', async () => {
    writeFileSync(
      join(nest, 'lark', 'skybridge.toml'),
      [
        '[server]',
        'url = "https://sync.example"',
        '[auth]',
        'user_id = "u-1"',
        'email = "me@example.com"',
        'token = "super-secret-token"',
        'refresh_token = "super-secret-refresh"',
        'expires_at = 1700000000000',
        '[device]',
        'id = "dev-1"',
        'name = "laptop"',
        '[workspace]',
        'id = "ws-1"',
      ].join('\n'),
      { mode: 0o600 },
    );
    const streams = captureStreams();

    await runSyncConfigShow({ streams, json: true });

    const printed = streams.stdout.join('\n');
    expect(printed).toContain('me@example.com');
    expect(printed).toContain('dev-1');
    expect(printed).not.toContain('super-secret-token');
    expect(printed).not.toContain('super-secret-refresh');
    expect(printed).toContain('"has_token":true');
  });
});

// ─── The --json contract (§7 F12 — criterion 45) ────────
//
// Exit 0 under --json promises stdout holds exactly one envelope and stderr
// holds nothing. Three human-mode lines were written outside that promise.

describe('--json keeps stderr empty on the success path', () => {
  it('says nothing extra while discarding a file op', async () => {
    const ctx = fakeContext({ syncFileOps: [fileOp()] }, { yes: true, json: true });

    await runSyncFileOps(ctx, { discard: '7' });

    // The row description is for the question — and under --json there is no
    // question, because --yes already answered it.
    expect(ctx.streams.stderr).toEqual([]);
    expect(ctx.streams.stdout).toHaveLength(1);
  });

  it('says nothing extra while unbinding', async () => {
    const ctx = fakeContext(
      { syncPending: { total: 4, unpublished_deletes: 2 }, syncUnbind: unbindResult },
      { yes: true, json: true },
    );

    await runSyncUnbind(ctx, {});

    expect(ctx.streams.stderr).toEqual([]);
    expect(ctx.streams.stdout).toHaveLength(1);
  });
});
