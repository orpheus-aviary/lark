// What the one-time m4a migration left behind (0.3.0 T3c, §3.2-1 / §4-m).
//
// It shows up only on a library that went through one — a fresh install has
// nothing to say here and should not carry a section about a version it never
// ran.
//
// Two actions, and both exist because of what the migration promised:
//
//   The originals it could not convert are in `migration-backup/`, forever,
//   until somebody says otherwise. "Forever" is only acceptable if it is
//   VISIBLE and reversible — hence the size, the button that opens the
//   directory, and the clear, which names how much of what it deletes is
//   irreplaceable before it does it.
//   The songs whose mp3 could not be read were discarded only after the source
//   answered a live probe, so they can be fetched again — as fresh AAC, which
//   is better than what the conversion would have produced. That is one button
//   over a list the report already has.

import { apiPath, request } from '@lark/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { batchMessage, runBatch } from '../../lib/batch-actions.js';
import { errorMessage } from '../../lib/errors.js';
import { getPlatform } from '../../platform/index.js';
import { useMigration } from '../../stores/migration.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { Button } from '../ui/button.js';
import { Section, formatSize } from './fields.js';

export function MigrationBlock(): React.JSX.Element | null {
  const report = useMigration((s) => s.report);
  const clearing = useMigration((s) => s.clearing);
  const refreshReport = useMigration((s) => s.refreshReport);
  const clearBackup = useMigration((s) => s.clearBackup);
  const [confirming, setConfirming] = useState(false);
  const [redownloading, setRedownloading] = useState(false);

  useEffect(() => {
    void refreshReport();
  }, [refreshReport]);

  // Nothing ever migrated here: a fresh 0.3 library, or one whose report and
  // backups are both empty. Rendering an empty box would be worse than silence.
  if (report === null || (report.counts.total === 0 && report.backup.file_count === 0)) {
    return null;
  }

  const { backup, counts } = report;
  // R-class songs whose mp3 was unreadable: the source answered a live probe
  // before the file went, so these are exactly the ones a re-download fixes.
  const lost = report.objects.filter(
    (object) => object.status === 'lost' && object.song_id !== null,
  );

  const clear = async (): Promise<void> => {
    setConfirming(false);
    try {
      const result = await clearBackup();
      toast.success(
        `已删除 ${result.removed_count} 个备份，释放 ${formatSize(result.freed_bytes)}`,
      );
      await refreshReport();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const redownload = async (): Promise<void> => {
    setRedownloading(true);
    try {
      const outcome = await runBatch(
        lost.map((object) => object.song_id as string),
        async (id) => {
          await request('POST', apiPath.songRedownload(id));
        },
        errorMessage,
      );
      const message = batchMessage(outcome, '已重新下载');
      if (message.ok) toast.success(message.text);
      else toast.error(message.text);
    } finally {
      setRedownloading(false);
    }
  };

  return (
    <Section title="迁移备份" hint="0.3 的一次性 mp3 → m4a 迁移留下的原始文件">
      <div className="space-y-2 rounded-md border border-border p-3 text-xs">
        <div className="grid grid-cols-[8rem_1fr] gap-y-1">
          <span className="text-muted-foreground">已转换</span>
          <span className="tabular-nums">{counts.done} 首</span>
          {counts.kept_unconverted > 0 && (
            <>
              <span className="text-muted-foreground">保留原件</span>
              <span className="tabular-nums">{counts.kept_unconverted} 首（无法转换）</span>
            </>
          )}
          {counts.lost > 0 && (
            <>
              <span className="text-muted-foreground">已丢弃</span>
              <span className="tabular-nums">{counts.lost} 首（文件损坏，可重新下载）</span>
            </>
          )}
          {counts.asset_missing > 0 && (
            <>
              <span className="text-muted-foreground">文件缺失</span>
              <span className="tabular-nums">{counts.asset_missing} 首</span>
            </>
          )}
          <span className="text-muted-foreground">备份占用</span>
          <span className="tabular-nums">
            {formatSize(backup.bytes)}（{backup.file_count} 个文件）
          </span>
        </div>

        {backup.asset_count > 0 && (
          <p className="text-muted-foreground">
            其中 {backup.asset_count} 个是无法转换的原件，{formatSize(backup.asset_bytes)}
            ——删掉就没有别的副本了。
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={backup.file_count === 0}
            onClick={() => void getPlatform().openMigrationBackup()}
          >
            打开备份目录
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="text-destructive"
            disabled={clearing || backup.file_count === 0}
            onClick={() => setConfirming(true)}
          >
            {clearing ? '清空中…' : '清空备份'}
          </Button>
          {lost.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              disabled={redownloading}
              onClick={() => void redownload()}
            >
              {redownloading ? '排队中…' : `重新下载 ${lost.length} 首`}
            </Button>
          )}
        </div>

        <ConfirmDialog
          open={confirming}
          title="清空迁移备份？"
          description={
            backup.asset_count > 0
              ? `将删除 ${backup.file_count} 个备份文件（${formatSize(backup.bytes)}），其中 ${backup.asset_count} 个是无法转换的原件（${formatSize(backup.asset_bytes)}）——这些文件没有其他副本，删除后无法恢复。`
              : `将删除 ${backup.file_count} 个备份文件（${formatSize(backup.bytes)}）。它们都是已成功转换歌曲的原件，曲库里已有对应的 m4a。`
          }
          confirmLabel="清空"
          destructive
          onConfirm={() => void clear()}
          onCancel={() => setConfirming(false)}
        />
      </div>
    </Section>
  );
}
