// The sync badge and its popover (v0.2 T4, §4.7).
//
// The badge is the only place a user finds out that sync stopped, so it says
// something in every state — including "未启用同步", which is what makes the
// feature discoverable at all.
//
// The popover is the product-level way OUT of the two states the daemon cannot
// resolve alone (R5-P1-1): a file effect that gave up after five attempts, and
// a conflict waiting for a person. Everything else on it is read-only.

import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/errors.js';
import { formatRelativeTime } from '../lib/format.js';
import { authReasonLabel, fileOpKindLabel, syncBadgeView } from '../lib/sync-labels.js';
import type { SyncTone } from '../lib/sync-labels.js';
import { useSettingsUi } from '../stores/settings-ui.js';
import { useSync } from '../stores/sync.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Button } from './ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

const TONE_DOT_CLASSES: Record<SyncTone, string> = {
  off: 'bg-muted-foreground/50',
  ok: 'bg-emerald-500',
  busy: 'bg-amber-400',
  warn: 'bg-amber-400',
  error: 'bg-red-500',
};

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{children}</span>
    </div>
  );
}

/**
 * The rows that gave up. Both exits are here on purpose: retry is the cheap
 * one and is offered first, discard destroys the file effect for good and is
 * confirmed against a sentence that says what will never happen now.
 */
function FileOpsBlock({ onDiscard }: { onDiscard: (id: number) => void }): React.JSX.Element {
  const ops = useSync((s) => s.failedFileOps);
  const retryFileOps = useSync((s) => s.retryFileOps);
  const [busy, setBusy] = useState(false);

  const retry = async (id?: number): Promise<void> => {
    setBusy(true);
    try {
      const result = await retryFileOps(id);
      if (result.failed > 0) toast.error(`重试后仍有 ${result.failed} 项失败`);
      else toast.success(`已执行 ${result.executed} 项文件操作`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-destructive">文件操作失败 {ops.length}</span>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void retry()}>
          全部重试
        </Button>
      </div>
      <ul className="space-y-2">
        {ops.map((op) => (
          <li key={op.id} className="space-y-1 rounded-md border border-border p-2">
            <p>
              {fileOpKindLabel(op)} · 已试 {op.attempts} 次
            </p>
            {op.last_error !== null && <p className="text-destructive">{op.last_error}</p>}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                aria-label={`重试文件操作 #${op.id}`}
                onClick={() => void retry(op.id)}
              >
                重试
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                aria-label={`放弃文件操作 #${op.id}`}
                onClick={() => onDiscard(op.id)}
              >
                放弃
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SyncBadge(): React.JSX.Element {
  const status = useSync((s) => s.status);
  const conflicts = useSync((s) => s.conflicts);
  const running = useSync((s) => s.running);
  const refresh = useSync((s) => s.refresh);
  const refreshConflicts = useSync((s) => s.refreshConflicts);
  const refreshFileOps = useSync((s) => s.refreshFileOps);
  const run = useSync((s) => s.run);
  const discardFileOp = useSync((s) => s.discardFileOp);
  const openSettings = useSettingsUi((s) => s.openSettings);

  const [open, setOpen] = useState(false);
  const [pendingDiscard, setPendingDiscard] = useState<number | null>(null);

  const view = syncBadgeView(status, conflicts);
  const needsLogin = status !== null && (!status.configured || status.state === 'auth_required');

  const syncNow = async (): Promise<void> => {
    try {
      const result = await run();
      toast.success(`同步完成：拉取 ${result.applied} 项，推送 ${result.pushed} 项`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const confirmDiscard = async (): Promise<void> => {
    const id = pendingDiscard;
    setPendingDiscard(null);
    if (id === null) return;
    try {
      await discardFileOp(id);
      toast.success('已放弃该文件操作');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Opening is the one moment the numbers are certainly being read.
          if (next) {
            refresh();
            refreshConflicts();
            refreshFileOps();
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 hover:text-foreground"
            aria-label={`同步：${view.label}`}
          >
            <span className={`inline-block size-2 rounded-full ${TONE_DOT_CLASSES[view.tone]}`} />
            <span>{view.label}</span>
            {view.attention > 0 && (
              <span className="rounded-sm bg-destructive px-1 font-medium text-destructive-foreground">
                {view.attention}
              </span>
            )}
          </button>
        </PopoverTrigger>

        <PopoverContent align="end" className="max-h-[70vh] w-96 overflow-y-auto p-0">
          <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
            <span className="font-medium text-sm">同步 · {view.label}</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={running || status?.authenticated !== true}
              title={status?.authenticated === true ? undefined : '需要先登录'}
              onClick={() => void syncNow()}
            >
              {running ? '同步中…' : '立即同步'}
            </Button>
          </div>

          <div className="space-y-3 px-3 py-2 text-xs">
            {status === null ? (
              <p className="text-muted-foreground">正在读取同步状态…</p>
            ) : (
              <>
                {needsLogin && (
                  <p className="text-muted-foreground">
                    {status.configured ? authReasonLabel(status.auth_reason) : '还没有配置同步。'}
                  </p>
                )}

                {status.bound && (
                  <div className="space-y-1">
                    <Row label="待推送">{status.pending_count}</Row>
                    <Row label="已拉取 / 已推送">
                      {status.pulled_seq} / {status.pushed_seq}
                    </Row>
                    <Row label="上次同步">
                      {status.last_sync_at === null
                        ? '从未'
                        : formatRelativeTime(status.last_sync_at, Date.now())}
                    </Row>
                  </div>
                )}

                {status.last_error !== null && status.state === 'error' && (
                  <p className="text-destructive">{status.last_error}</p>
                )}

                {conflicts > 0 && (
                  <p className="text-destructive">有 {conflicts} 处冲突等待处理。</p>
                )}

                {status.file_op_failures > 0 && (
                  <FileOpsBlock
                    onDiscard={(id) => {
                      // The confirmation is a Dialog, and a Dialog opened from
                      // inside a Popover fights it for focus — TopBar settled
                      // this the same way: close first, then ask.
                      setOpen(false);
                      setPendingDiscard(id);
                    }}
                  />
                )}

                {status.pending_file_ops > 0 && (
                  <p className="text-muted-foreground">
                    还有 {status.pending_file_ops} 项文件操作排队中。
                  </p>
                )}

                {status.quarantined_count > 0 && (
                  <p className="text-muted-foreground">
                    已隔离 {status.quarantined_count} 首歌的文件到 recovered-songs/ ——
                    是别的设备删掉了它们，但本机的文件无法重新下载或还没同步出去。
                  </p>
                )}

                {status.duplicate_source_keys > 0 && (
                  <p className="text-muted-foreground">
                    有 {status.duplicate_source_keys} 首歌与其他歌曲来源相同（列表里标了「重复」），
                    删掉多余的一首即可。
                  </p>
                )}

                {(status.dead_letters.in > 0 || status.dead_letters.out > 0) && (
                  <p className="text-muted-foreground">
                    有无法处理的变更：收到 {status.dead_letters.in} 条 / 发出{' '}
                    {status.dead_letters.out} 条，已留档但不会生效。
                  </p>
                )}

                <Button
                  size="sm"
                  variant={needsLogin ? 'default' : 'secondary'}
                  onClick={() => {
                    setOpen(false);
                    openSettings();
                  }}
                >
                  {needsLogin ? '去登录…' : '同步设置…'}
                </Button>
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>

      <ConfirmDialog
        open={pendingDiscard !== null}
        title="放弃文件操作"
        description="放弃后这次文件操作永远不会执行：该删的文件会留下、该写的歌词不会写入，只在日志里留一条记录。确定吗？"
        confirmLabel="放弃"
        destructive
        onConfirm={() => void confirmDiscard()}
        onCancel={() => setPendingDiscard(null)}
      />
    </>
  );
}
