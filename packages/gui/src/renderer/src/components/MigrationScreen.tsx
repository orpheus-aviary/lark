// What the window shows while the library is being converted (0.3.0 T3c,
// §3.2-4). It replaces the whole app, because there is no library to show:
// every business route answers `AUDIO_MIGRATION_PENDING` until this is over.
//
// It is not only a progress bar. Two of the three ways this pass can stall need
// a person, and this screen is where they are:
//
//   `blocked_environment` — no space, no ffmpeg, a directory that cannot be
//   written. Nothing was touched; fix the machine and press the button.
//   `blocked_file_op` — a sync file operation that gave up owns a song's
//   directory. The pass may not touch it, so the same retry/discard list the
//   sync settings use is offered right here.
//
// Everything comes from polling. During the migration the GUI has no SSE
// command channel — it is not on the whitelist — so `/status` at one second is
// the feed, and the report is refetched alongside it.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/errors.js';
import { attentionCount, settledCount, useMigration } from '../stores/migration.js';
import { useSync } from '../stores/sync.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { DISCARD_FILE_OP_DESCRIPTION, SyncFileOpsList } from './SyncFileOpsList.js';
import { Button } from './ui/button.js';

export function MigrationScreen(): React.JSX.Element {
  const counts = useMigration((s) => s.counts);
  const report = useMigration((s) => s.report);
  const retrying = useMigration((s) => s.retrying);
  const retry = useMigration((s) => s.retry);
  const refreshReport = useMigration((s) => s.refreshReport);
  const refreshFileOps = useSync((s) => s.refreshFileOps);
  const discardFileOp = useSync((s) => s.discardFileOp);
  const [discarding, setDiscarding] = useState<number | null>(null);

  const blockedFileOps = counts?.blocked_file_op ?? 0;

  // The detail feed. `/status` is polled by the gate above this screen; this is
  // the second half of the same tick — and the file-op list only when there is
  // one to show, since it is the one read that exists to be acted on.
  useEffect(() => {
    void refreshReport();
    const timer = setInterval(() => void refreshReport(), 1000);
    return () => clearInterval(timer);
  }, [refreshReport]);

  useEffect(() => {
    if (blockedFileOps > 0) void refreshFileOps();
  }, [blockedFileOps, refreshFileOps]);

  const runRetry = async (): Promise<void> => {
    try {
      const result = await retry();
      if (result.started) toast.success('已重新检测，迁移继续');
      else toast.message('迁移已经结束');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const confirmDiscard = async (): Promise<void> => {
    const id = discarding;
    setDiscarding(null);
    if (id === null) return;
    try {
      await discardFileOp(id);
      toast.success('已放弃该文件操作');
      await refreshReport();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const total = counts?.total ?? 0;
  const settled = counts === null ? 0 : settledCount(counts);
  const attention = counts === null ? 0 : attentionCount(counts);
  const blockedEnvironment = counts?.state === 'blocked_environment';

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-8">
      <div className="w-full max-w-xl space-y-4">
        <div className="space-y-1">
          <h1 className="font-medium text-lg">正在把曲库转换成 m4a</h1>
          <p className="text-muted-foreground text-sm">
            这是一次性的：0.3 起 lark 只用 <code>song.m4a</code>。完成前曲库暂时不可用，
            原始文件不会被静默删除。
          </p>
        </div>

        <div className="space-y-2">
          {/* The native element, not a styled div with role="progressbar": it
              carries the value to a screen reader without an aria triplet to
              keep in step, and `accent-color` is enough to make it lark's. */}
          <progress
            className="h-2 w-full [accent-color:var(--state-active)]"
            value={settled}
            max={total === 0 ? 1 : total}
            aria-label="迁移进度"
          />
          <p className="text-muted-foreground text-xs tabular-nums">
            {settled} / {total} 首已处理
            {counts !== null && counts.lost > 0 && ` · 无法读取已丢弃 ${counts.lost}`}
            {counts !== null &&
              counts.kept_unconverted > 0 &&
              ` · 保留原件 ${counts.kept_unconverted}`}
            {counts !== null && counts.asset_missing > 0 && ` · 文件缺失 ${counts.asset_missing}`}
            {attention > 0 && ` · 待处理 ${attention}`}
          </p>
        </div>

        {blockedEnvironment && (
          <div className="space-y-2 rounded-md border border-destructive p-3 text-xs">
            <p className="text-destructive">迁移已暂停，没有删除任何文件。</p>
            {report?.reason !== null && report?.reason !== undefined && (
              <p className="text-muted-foreground">{report.reason}</p>
            )}
            <Button size="sm" disabled={retrying} onClick={() => void runRetry()}>
              {retrying ? '检测中…' : '重新检测并继续'}
            </Button>
          </div>
        )}

        {blockedFileOps > 0 && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground">
              有 {blockedFileOps} 首歌的目录被未完成的同步文件操作占用，处理掉它们迁移才能继续。
            </p>
            <SyncFileOpsList onDiscard={(id) => setDiscarding(id)} />
          </div>
        )}

        {report?.objects.some((object) => object.status === 'blocked') && (
          <div className="space-y-2 rounded-md border border-border p-3 text-xs">
            <p className="text-destructive">下列文件需要手动处理（通常是权限问题）：</p>
            <ul className="space-y-1">
              {report.objects
                .filter((object) => object.status === 'blocked')
                .map((object) => (
                  <li key={object.object_key} className="break-all">
                    <span className="font-mono">{object.object_key}</span>
                    {object.last_error !== null && (
                      <span className="text-muted-foreground"> — {object.last_error}</span>
                    )}
                  </li>
                ))}
            </ul>
            <Button
              size="sm"
              variant="secondary"
              disabled={retrying}
              onClick={() => void runRetry()}
            >
              {retrying ? '重试中…' : '重试'}
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={discarding !== null}
        title="放弃这次文件操作？"
        description={DISCARD_FILE_OP_DESCRIPTION}
        confirmLabel="放弃"
        destructive
        onConfirm={() => void confirmDiscard()}
        onCancel={() => setDiscarding(null)}
      />
    </div>
  );
}
