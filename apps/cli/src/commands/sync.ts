// `lark sync …` (v0.2 T5, §4.7).
//
// Seven commands, and the interesting part is which of them talks to what:
//
//   login / logout / run / status / file-ops go through the DAEMON. The
//     session, the token refresh and the round coalescer live there; a second
//     syncer in a CLI process would push the same changes under a second
//     identity.
//   unbind runs with the library to ITSELF — no daemon, writer lock held —
//     because it clears the outbox, the tombstones and the binding.
//   config-show reads the credential file and nothing else, so it works when
//     there is no daemon and no database at all. It is also the one command
//     that must never print a token: it renders the public projection, where
//     the token is a boolean.
//
// Two destructive answers are confirmed rather than assumed: discarding a file
// operation (it will never happen) and unbinding (the unpushed deletes cannot
// be republished — R5-P1-3, which is why the count is named BEFORE the
// question, not after the fact).

import { publicSkybridgeCredentials, readSkybridgeCredentials } from '@lark/core/config';
import type { SyncFileOpSummary, SyncStatusData } from '@lark/shared';
import { SYNC_FILE_OP_STATES, type SyncFileOpState } from '@lark/shared';
import type { CommandContext } from '../context.js';
import { confirm } from '../lib/confirm.js';
import { usageError } from '../lib/errors.js';
import { emitEnvelope, successEnvelope } from '../lib/output.js';
import type { Streams } from '../lib/output.js';
import { type SecretOptions, readSecret } from '../lib/prompt.js';

const STATE_LABELS: Record<SyncStatusData['state'], string> = {
  idle: '空闲',
  syncing: '同步中',
  error: '出错',
  offline: '离线',
  auth_required: '需要登录',
};

const AUTH_REASON_LABELS: Record<NonNullable<SyncStatusData['auth_reason']>, string> = {
  missing_session: '还没有登录',
  token_rejected: '服务器拒绝了保存的凭证',
  credentials_missing: '凭证文件里没有登录信息',
};

function timestamp(ms: number | null): string {
  return ms === null ? '从未' : new Date(ms).toLocaleString();
}

// ─── status ────────────────────────────────────────────

export async function runSyncStatus(ctx: CommandContext): Promise<void> {
  const envelope = await ctx.backend.syncStatus();
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const status = envelope.data;
  if (status === undefined) return ctx.streams.out('（daemon 没有返回同步状态）');

  const out = ctx.streams.out;
  const reason = status.auth_reason === null ? '' : `（${AUTH_REASON_LABELS[status.auth_reason]}）`;
  out(`状态：${STATE_LABELS[status.state]}${reason}`);
  out(`服务器：${status.server_url ?? '（未配置）'}`);
  out(`绑定：${status.bound ? `workspace ${status.workspace_id}` : '未绑定'}`);
  out(`设备：${status.device_id ?? '（未注册）'}`);
  out(`待推送：${status.pending_count}`);
  out(`游标：已拉取 ${status.pulled_seq} / 已推送 ${status.pushed_seq}`);
  out(`上次同步：${timestamp(status.last_sync_at)}`);
  if (status.last_error !== null) out(`最近错误：${status.last_error}`);
  if (status.pending_file_ops > 0 || status.file_op_failures > 0) {
    out(`文件操作：排队 ${status.pending_file_ops} / 永久失败 ${status.file_op_failures}`);
  }
  if (status.last_file_error !== null) out(`文件操作错误：${status.last_file_error}`);
  if (status.quarantined_count > 0)
    out(`已隔离：${status.quarantined_count} 首（recovered-songs/）`);
  if (status.duplicate_source_keys > 0) {
    out(`来源重复：${status.duplicate_source_keys} 首（\`lark songs list --duplicates\` 可列出）`);
  }
  if (status.dead_letters.in > 0 || status.dead_letters.out > 0) {
    out(`无法处理的变更：收 ${status.dead_letters.in} / 发 ${status.dead_letters.out}`);
  }
}

// ─── login / logout ────────────────────────────────────

export interface LoginOptions {
  server?: string;
  email?: string;
  passwordStdin?: boolean;
  allowInsecureHttp?: boolean;
}

/** Shape rules, run before the daemon is probed (M6: exit 2, not exit 4). */
export function assertLoginShape(opts: LoginOptions): void {
  if (opts.server === undefined || opts.server.trim() === '') {
    throw usageError('缺少 --server：同步服务器地址（例如 https://sync.example.com）。');
  }
  if (opts.email === undefined || opts.email.trim() === '') {
    throw usageError('缺少 --email：登录用的邮箱。');
  }
}

/** Test seams for the password read; production passes none. */
export type SecretSeams = Pick<SecretOptions, 'isTty' | 'readStdin' | 'promptSecret'>;

export async function runSyncLogin(
  ctx: CommandContext,
  opts: LoginOptions,
  secret: SecretSeams = {},
): Promise<void> {
  // The breaker takes two deliberate acts, exactly like the GUI's checkbox and
  // dialog: the flag says "I know", the confirmation says what it costs.
  if (opts.allowInsecureHttp === true) {
    await confirm('明文 HTTP 会把密码原样发出去，同一网络上的任何人都可能读到。继续？', {
      yes: ctx.flags.yes,
      json: ctx.flags.json,
    });
  }

  const password = await readSecret('skybridge 密码：', {
    fromStdin: opts.passwordStdin === true,
    json: ctx.flags.json,
    ...secret,
  });

  const envelope = await ctx.backend.syncLogin({
    server_url: (opts.server ?? '').trim(),
    email: (opts.email ?? '').trim(),
    password,
    ...(opts.allowInsecureHttp === true ? { allow_insecure_http: true } : {}),
  });
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const result = envelope.data;
  if (result === undefined) return ctx.streams.out('已登录。');
  ctx.streams.out(`已登录：${result.email} @ ${result.server_url}`);
  ctx.streams.out(
    `设备：${result.device_name}（${result.device_id}${result.device_reused ? '，复用' : '，新注册'}）`,
  );
  ctx.streams.out(`workspace：${result.workspace_id}`);
  if (result.backfill !== null) {
    const backfill = result.backfill;
    ctx.streams.out(
      `首次绑定，已排入回填：${backfill.songs} 首歌 / ${backfill.playlists} 个歌单 / ${backfill.memberships} 条成员 / ${backfill.lyrics} 份歌词`,
    );
    if (backfill.lyrics_oversize > 0) {
      ctx.streams.out(`其中 ${backfill.lyrics_oversize} 份歌词过大，无法同步（已留档）`);
    }
  }
  if (result.rebased_entities > 0) {
    ctx.streams.out(`已按服务器时钟重排 ${result.rebased_entities} 个实体的未推送变更`);
  }
  if (result.device_stamp === 'device-changed') {
    ctx.streams.out('检测到设备更换：未推送的变更已重新标注为本设备');
  }
}

export async function runSyncLogout(ctx: CommandContext): Promise<void> {
  const envelope = await ctx.backend.syncLogout();
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const result = envelope.data;
  if (result?.had_session !== true) return ctx.streams.out('本来就没有登录。');
  ctx.streams.out(
    result.revoked_remotely
      ? '已登出（服务器端凭证也已作废）。'
      : '已登出（没能通知服务器，本机凭证已清除）。',
  );
  ctx.streams.out('绑定关系与未同步的变更都保留，重新登录即可继续。');
}

// ─── run ───────────────────────────────────────────────

export async function runSyncRun(ctx: CommandContext): Promise<void> {
  const envelope = await ctx.backend.syncRun();
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const result = envelope.data;
  if (result === undefined) return ctx.streams.out('同步完成。');
  ctx.streams.out(
    `同步完成：拉取 ${result.pulled}（应用 ${result.applied}，跳过 ${result.skipped}），推送 ${result.pushed}`,
  );
  if (result.conflicts > 0) ctx.streams.out(`新增冲突 ${result.conflicts} 处——在 GUI 里处理`);
  if (result.dead_lettered > 0)
    ctx.streams.out(`无法处理的变更 ${result.dead_lettered} 条（已留档）`);
  if (result.cancelled) ctx.streams.out('这一轮被中断（会话已更换），下一轮会续上。');
  ctx.streams.out(`游标：已拉取 ${result.pulled_seq} / 已推送 ${result.pushed_seq}`);
}

// ─── file-ops ──────────────────────────────────────────

export interface FileOpsOptions {
  state?: string;
  /** `--retry` with no value means "every failed row". */
  retry?: string | boolean;
  discard?: string;
}

function opLine(op: SyncFileOpSummary): string {
  const parts = [`#${op.id}`, op.kind, `song ${op.song_id}`, `已试 ${op.attempts} 次`];
  if (op.inline !== null) parts.push(`内联 ${op.inline.size}B`);
  const head = parts.join(' · ');
  return op.last_error === null ? head : `${head}\n    ${op.last_error}`;
}

function opId(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw usageError(`${flag} 需要一个正整数 id，收到 ${JSON.stringify(raw)}`);
  }
  return value;
}

export function assertFileOpsShape(opts: FileOpsOptions): void {
  if (opts.retry !== undefined && opts.discard !== undefined) {
    throw usageError('--retry 与 --discard 不能同时使用。');
  }
  if (
    opts.state !== undefined &&
    !(SYNC_FILE_OP_STATES as readonly string[]).includes(opts.state)
  ) {
    throw usageError(`--state 只能是 ${SYNC_FILE_OP_STATES.join(' / ')}`);
  }
}

export async function runSyncFileOps(ctx: CommandContext, opts: FileOpsOptions): Promise<void> {
  if (opts.discard !== undefined) return discardFileOp(ctx, opId(opts.discard, '--discard'));
  if (opts.retry !== undefined) {
    const id = typeof opts.retry === 'string' ? opId(opts.retry, '--retry') : undefined;
    return retryFileOps(ctx, id);
  }

  const envelope = await ctx.backend.syncFileOps(opts.state as SyncFileOpState | undefined);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const ops = envelope.data?.file_ops ?? [];
  if (ops.length === 0) return ctx.streams.out('（没有排队或失败的文件操作）');
  for (const op of ops) ctx.streams.out(opLine(op));
}

async function retryFileOps(ctx: CommandContext, id: number | undefined): Promise<void> {
  const envelope = await ctx.backend.syncFileOpsRetry(id);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const result = envelope.data;
  ctx.streams.out(
    `已执行 ${result?.executed ?? 0} 项，失败 ${result?.failed ?? 0} 项，跳过 ${result?.skipped ?? 0} 项`,
  );
}

async function discardFileOp(ctx: CommandContext, id: number): Promise<void> {
  // Name what is being abandoned before asking. The list is the only place the
  // row's kind and error live, and "discard #7" is not a question anyone can
  // answer well.
  const listed = await ctx.backend.syncFileOps('failed');
  const target = listed.data?.file_ops.find((op) => op.id === id);
  if (target !== undefined) ctx.streams.err(opLine(target));

  await confirm(`放弃文件操作 #${id}？这次文件改动永远不会执行，只在日志里留一条记录。`, {
    yes: ctx.flags.yes,
    json: ctx.flags.json,
  });

  const envelope = await ctx.backend.syncFileOpsDiscard(id);
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);
  ctx.streams.out(`已放弃文件操作 #${id}。`);
}

// ─── unbind ────────────────────────────────────────────

export interface UnbindOptions {
  force?: boolean;
}

export async function runSyncUnbind(ctx: CommandContext, opts: UnbindOptions): Promise<void> {
  const force = opts.force === true;

  // The count comes first (R5-P1-3): a confirmation that cannot say how much
  // is being thrown away is not a confirmation.
  const pending = (await ctx.backend.syncPendingChanges()).data ?? {
    total: 0,
    unpublished_deletes: 0,
  };
  const lines = [
    '解除绑定会清空同步状态：未推送的变更、墓碑、游标与本机的 skybridge 凭证。',
    '仍然存在的歌曲和歌单，下次登录会重新回填；但已经删除的东西无法回填。',
  ];
  if (pending.total > 0) {
    lines.push(
      `当前有 ${pending.total} 条未推送变更，其中 ${pending.unpublished_deletes} 条是删除 / 清空歌词——重新绑定同一个 workspace 时，它们会被远端的旧记录复活。`,
    );
  }
  for (const line of lines) ctx.streams.err(line);

  await confirm('确定解除绑定？', { yes: ctx.flags.yes, json: ctx.flags.json });

  const envelope = await ctx.backend.syncUnbind({ force });
  if (ctx.flags.json) return emitEnvelope(ctx.streams, envelope);

  const result = envelope.data;
  if (result === undefined) return ctx.streams.out('已解除绑定。');
  // Idempotent, and it says so: running it on a library that was never bound
  // is a no-op, not a repair somebody should go looking for.
  const cleared =
    result.changes + result.tombstones + result.dead_letters + result.cursors > 0 ||
    result.had_credentials;
  if (!cleared) return ctx.streams.out('本来就没有绑定过任何 workspace，没有可清除的内容。');
  ctx.streams.out(
    `已解除绑定：清除 ${result.changes} 条变更 / ${result.tombstones} 条墓碑 / ${result.dead_letters} 条留档 / ${result.cursors} 个游标`,
  );
  if (result.discarded_changes > 0) {
    ctx.streams.out(
      `已放弃 ${result.discarded_changes} 条未推送变更（其中 ${result.discarded_deletes} 条删除 / 清空无法重新发布）`,
    );
  }
  ctx.streams.out(result.had_credentials ? '本机凭证已删除。' : '本机原本就没有凭证。');
  ctx.streams.out('下次登录会做一次完整回填。');
}

// ─── config-show ───────────────────────────────────────

/**
 * The credential file, minus the credentials.
 *
 * Reads the file directly rather than asking the daemon: this is the command a
 * user runs when sync is NOT working, which is exactly when there may be no
 * daemon to ask. `has_token` is a boolean on purpose — the token never gets
 * printed, not even truncated.
 */
export function runSyncConfigShow(deps: { streams: Streams; json: boolean }): Promise<void> {
  const credentials = publicSkybridgeCredentials(readSkybridgeCredentials());
  if (deps.json) {
    emitEnvelope(deps.streams, successEnvelope(credentials));
    return Promise.resolve();
  }

  if (credentials.server_url === '') {
    deps.streams.out('（还没有配置同步：没有 skybridge.toml，或者里面没有服务器地址）');
    return Promise.resolve();
  }
  const out = deps.streams.out;
  out(
    `服务器：${credentials.server_url}${credentials.allow_insecure_http ? '（允许明文 HTTP）' : ''}`,
  );
  out(`账号：${credentials.email ?? '（未登录）'}`);
  out(
    `凭证：${credentials.has_token ? '已保存' : '无'}，刷新令牌 ${credentials.has_refresh_token ? '有' : '无'}`,
  );
  out(`凭证到期：${timestamp(credentials.expires_at)}`);
  out(`设备：${credentials.device_name ?? '（未注册）'}（${credentials.device_id ?? '-'}）`);
  out(`workspace：${credentials.workspace_id ?? '（未绑定）'}`);
  return Promise.resolve();
}
