// What the sync badge says, as pure functions (v0.2 T4).
//
// Kept out of the component so the mapping can be tested directly: the badge
// is the only place a user learns that sync stopped, and "which sentence for
// which state" is exactly the part that is easy to get subtly wrong.

import type { SyncAuthReason, SyncFileOpSummary, SyncStatusData } from '@lark/shared';

/**
 * Five tones, not five colours: the component owns the palette. `off` covers
 * both "never set up" and "cannot reach the server" — neither is a fault the
 * user has to act on, and painting an unreachable server red would make an
 * ordinary offline laptop look broken.
 */
export type SyncTone = 'off' | 'ok' | 'busy' | 'warn' | 'error';

export interface SyncBadgeView {
  tone: SyncTone;
  label: string;
  /** Rows that need a person: conflicts plus file ops that gave up. */
  attention: number;
}

export function syncBadgeView(status: SyncStatusData | null, conflicts: number): SyncBadgeView {
  const attention = conflicts + (status?.file_op_failures ?? 0);
  if (status === null) return { tone: 'off', label: '同步状态未知', attention };
  if (!status.configured) return { tone: 'off', label: '未启用同步', attention };

  switch (status.state) {
    case 'syncing':
      return { tone: 'busy', label: '同步中…', attention };
    case 'auth_required':
      return { tone: 'warn', label: '需要登录', attention };
    case 'error':
      return { tone: 'error', label: '同步出错', attention };
    case 'offline':
      return { tone: 'off', label: '同步离线', attention };
    case 'idle':
      return {
        tone: 'ok',
        label: status.pending_count > 0 ? `待同步 ${status.pending_count}` : '已同步',
        attention,
      };
  }
}

const AUTH_REASON_LABELS: Record<SyncAuthReason, string> = {
  missing_session: '还没有登录 skybridge。',
  token_rejected: '登录已失效（服务器拒绝了保存的凭证），需要重新登录。',
  credentials_missing: '凭证文件里没有登录信息，需要重新登录。',
};

export function authReasonLabel(reason: SyncAuthReason | null): string {
  return reason === null ? '需要登录才能同步。' : AUTH_REASON_LABELS[reason];
}

/**
 * The daemon's sync errors are written for the CLI ("run `lark sync unbind`"),
 * which is the wrong instruction to give someone looking at a window. The
 * three that a login can legitimately hit get a GUI sentence; everything else
 * falls through to the daemon's own message rather than being flattened into a
 * useless "登录失败".
 */
export function loginErrorMessage(errorCode: string | undefined, message: string): string {
  switch (errorCode) {
    case 'SYNC_BINDING_MISMATCH':
      return `这个曲库已经绑定到另一个账号或 workspace，不能改绑：${message}`;
    case 'SYNC_SCHEMA_VERSION_MISMATCH':
      return '服务器与本机的同步协议版本不一致，请先升级较旧的一端。';
    case 'SYNC_INSECURE_URL':
      return '服务器地址不是 HTTPS。登录会发送密码，所以默认拒绝——确实要用明文 HTTP，请勾选下面的选项。';
    default:
      return message;
  }
}

const FILE_OP_KIND_LABELS: Record<string, string> = {
  delete_song_files: '删除歌曲文件',
  quarantine_song_files: '隔离歌曲文件',
  write_lyrics: '写入歌词',
  delete_lyrics: '删除歌词',
};

/** An unknown kind is shown verbatim: a newer daemon must not print "未知". */
export function fileOpKindLabel(op: SyncFileOpSummary): string {
  return FILE_OP_KIND_LABELS[op.kind] ?? op.kind;
}
