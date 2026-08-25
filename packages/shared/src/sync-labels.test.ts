// Characterization for the sync wording, written BEFORE it moves (N5a).
//
// The tables have had no direct tests since v0.2 T4 — the same hole
// `download-labels` was in before N4d lifted it — so this file first pins what
// the GUI renders TODAY. The move to `@lark/shared` then has to keep every one
// of these green without touching a character, and the one deliberate change
// (the `SYNC_INSECURE_URL` sentence, subplan §1.6) arrives as its own edit
// with its own failing-then-passing assertion rather than hiding inside a
// refactor.
//
// The exhaustiveness cases are the part worth keeping afterwards: a new
// `SyncState` or `SyncAuthReason` in `sync-types.ts` must not reach a screen
// as `undefined`.

import { describe, expect, it } from 'vitest';
import {
  authReasonLabel,
  fileOpKindLabel,
  loginErrorMessage,
  syncBadgeView,
} from './sync-labels.js';
import {
  SYNC_AUTH_REASONS,
  SYNC_STATES,
  type SyncAuthReason,
  type SyncFileOpSummary,
  type SyncStatusData,
} from './sync-types.js';

function status(overrides: Partial<SyncStatusData> = {}): SyncStatusData {
  return {
    configured: true,
    authenticated: true,
    bound: true,
    server_url: 'https://sync.example.test',
    device_id: 'device-1',
    workspace_id: 'workspace-1',
    pending_count: 0,
    pulled_seq: 7,
    pushed_seq: 7,
    last_sync_at: 1_700_000_000_000,
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

function fileOp(kind: string): SyncFileOpSummary {
  return {
    id: 1,
    kind,
    song_id: '11111111-1111-4111-8111-111111111111',
    attempts: 3,
    last_error: null,
    next_retry_at: null,
    created_at: 1_700_000_000_000,
    inline: null,
  };
}

describe('syncBadgeView', () => {
  it('reports an unknown status as off rather than as a fault', () => {
    expect(syncBadgeView(null, 0)).toEqual({ tone: 'off', label: '同步状态未知', attention: 0 });
  });

  it('reports a library that was never set up as off', () => {
    expect(syncBadgeView(status({ configured: false }), 0)).toEqual({
      tone: 'off',
      label: '未启用同步',
      attention: 0,
    });
  });

  it('maps each state to its tone and sentence', () => {
    expect(syncBadgeView(status({ state: 'syncing' }), 0)).toMatchObject({
      tone: 'busy',
      label: '同步中…',
    });
    expect(syncBadgeView(status({ state: 'auth_required' }), 0)).toMatchObject({
      tone: 'warn',
      label: '需要登录',
    });
    expect(syncBadgeView(status({ state: 'error' }), 0)).toMatchObject({
      tone: 'error',
      label: '同步出错',
    });
    // An unreachable server is deliberately NOT red: an offline laptop is not
    // broken, and painting it as a fault is how a badge stops being read.
    expect(syncBadgeView(status({ state: 'offline' }), 0)).toMatchObject({
      tone: 'off',
      label: '同步离线',
    });
    expect(syncBadgeView(status({ state: 'idle' }), 0)).toMatchObject({
      tone: 'ok',
      label: '已同步',
    });
  });

  it('counts what is waiting to be pushed when idle', () => {
    expect(syncBadgeView(status({ state: 'idle', pending_count: 12 }), 0).label).toBe('待同步 12');
  });

  it('adds conflicts and give-up file ops into one attention number', () => {
    expect(syncBadgeView(status({ file_op_failures: 2 }), 3).attention).toBe(5);
  });

  it('still carries attention when there is no status at all', () => {
    expect(syncBadgeView(null, 4).attention).toBe(4);
  });

  it('答得出每一个 SyncState', () => {
    for (const state of SYNC_STATES) {
      const view = syncBadgeView(status({ state }), 0);
      expect(view.label, state).not.toBe('');
      expect(view.label, state).not.toContain('undefined');
    }
  });
});

describe('authReasonLabel', () => {
  it('falls back to a general sentence when there is no reason', () => {
    expect(authReasonLabel(null)).toBe('需要登录才能同步。');
  });

  it('names each reason', () => {
    expect(authReasonLabel('missing_session')).toBe('还没有登录 skybridge。');
    expect(authReasonLabel('token_rejected')).toBe(
      '登录已失效（服务器拒绝了保存的凭证），需要重新登录。',
    );
    expect(authReasonLabel('credentials_missing')).toBe('凭证文件里没有登录信息，需要重新登录。');
  });

  it('答得出每一个 SyncAuthReason', () => {
    for (const reason of SYNC_AUTH_REASONS satisfies readonly SyncAuthReason[]) {
      expect(authReasonLabel(reason), reason).not.toContain('undefined');
    }
  });
});

describe('loginErrorMessage', () => {
  it('explains a binding mismatch with the daemon message kept', () => {
    expect(loginErrorMessage('SYNC_BINDING_MISMATCH', 'server_id 不一致')).toBe(
      '这个曲库已经绑定到另一个账号或 workspace，不能改绑：server_id 不一致',
    );
  });

  it('replaces the protocol mismatch wholesale', () => {
    expect(loginErrorMessage('SYNC_SCHEMA_VERSION_MISMATCH', 'v3 != v2')).toBe(
      '服务器与本机的同步协议版本不一致，请先升级较旧的一端。',
    );
  });

  // The one deliberate change in N5a (subplan §1.6, criterion 68). The old
  // sentence ended "请勾选下面的选项", which described where the desktop's
  // checkbox sits — a sentence two front ends cannot share.
  it('names the setting to open, without saying where it sits', () => {
    const said = loginErrorMessage('SYNC_INSECURE_URL', 'is plaintext http');
    expect(said).toContain('不是 HTTPS');
    expect(said).toContain('允许明文 HTTP');
    expect(said).not.toContain('下面');
  });

  it('passes anything else through rather than flattening it', () => {
    expect(loginErrorMessage('SYNC_UNAVAILABLE', '服务器没有响应')).toBe('服务器没有响应');
    expect(loginErrorMessage(undefined, '原始消息')).toBe('原始消息');
  });
});

describe('fileOpKindLabel', () => {
  it('names the four kinds the journal writes', () => {
    expect(fileOpKindLabel(fileOp('delete_song_files'))).toBe('删除歌曲文件');
    expect(fileOpKindLabel(fileOp('quarantine_song_files'))).toBe('隔离歌曲文件');
    expect(fileOpKindLabel(fileOp('write_lyrics'))).toBe('写入歌词');
    expect(fileOpKindLabel(fileOp('delete_lyrics'))).toBe('删除歌词');
  });

  it('shows an unknown kind verbatim — a newer peer must not print 未知', () => {
    expect(fileOpKindLabel(fileOp('rewrite_everything'))).toBe('rewrite_everything');
  });
});
