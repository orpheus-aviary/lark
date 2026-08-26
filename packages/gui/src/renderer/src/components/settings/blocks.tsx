// The three read-mostly blocks on the general tab (split out of SettingsDialog
// in v0.2 T4; behaviour unchanged): what the cache holds, where ffmpeg came
// from, and which licences actually shipped.

import { useState } from 'react';
import { toast } from 'sonner';
import type { LegalDocument } from '../../../../shared/lark-api.js';
import { errorMessage } from '../../lib/errors.js';
import { useCache } from '../../stores/cache.js';
import { mediaToolsWarning, useMediaTools } from '../../stores/media-tools.js';
import { Button } from '../ui/button.js';
import { formatSize } from './fields.js';

export function CacheBlock(): React.JSX.Element {
  const status = useCache((s) => s.status);
  const evicting = useCache((s) => s.evicting);
  const evict = useCache((s) => s.evict);

  const runEviction = async (): Promise<void> => {
    try {
      const result = await evict();
      const freed = `清理 ${result.evicted_count} 首，释放 ${formatSize(result.freed_bytes)}`;
      const skipped =
        result.skipped_unverified_count > 0
          ? `；另有 ${result.skipped_unverified_count} 首暂未能联网确认可重下，已跳过`
          : '';
      toast.success(`${freed}${skipped}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (status === null) return <p className="text-muted-foreground text-xs">正在读取缓存状态…</p>;

  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-xs">
      {/* Two figures since N7, because the limit is about this MACHINE and a
          device can hold several libraries. They add up to every byte of lark
          audio on the disk (criterion 119), and a drain frees the other ones
          first — the library on screen keeps its files longest. */}
      <div className="grid grid-cols-2 gap-y-1">
        <span className="text-muted-foreground">当前曲库</span>
        <span className="tabular-nums">{formatSize(status.used_bytes)}</span>
        {status.other_bytes > 0 && (
          <>
            <span className="text-muted-foreground">其他曲库</span>
            <span className="tabular-nums">
              {formatSize(status.other_bytes)}（{status.other_files} 个文件，清理时先动这些）
            </span>
          </>
        )}
        <span className="text-muted-foreground">按资格可清理（未验证）</span>
        <span className="tabular-nums">{formatSize(status.eligible_bytes)}</span>
        <span className="text-muted-foreground">不可回收</span>
        <span className="tabular-nums">{formatSize(status.unreclaimable_bytes)}</span>
      </div>
      {/* The two reasons a limit can stay unmet are different problems, so they
          are stated separately rather than blamed on pins and imports (M5-18). */}
      {!status.limit_satisfied && (
        <p className="text-muted-foreground">
          当前超出上限：其中 {formatSize(status.unreclaimable_bytes)} 属固定 / 导入 /
          正在使用的文件，无法回收。
        </p>
      )}
      <Button size="sm" variant="secondary" disabled={evicting} onClick={() => void runEviction()}>
        {evicting ? '清理中…' : '立即清理'}
      </Button>
    </div>
  );
}

const MEDIA_TOOL_SOURCES: Record<string, string> = {
  env: '环境变量指定',
  bundle: '应用内置',
  homebrew: 'Homebrew',
  path: 'PATH',
};

/**
 * Where ffmpeg came from and whether it works (M7-18).
 *
 * The path and the source are both shown on purpose: "bundled" and "the one
 * you installed with brew" fail in different ways, and a bug report that
 * cannot tell them apart is unactionable.
 */
export function MediaToolsBlock(): React.JSX.Element {
  const info = useMediaTools((s) => s.info);
  if (info === null) return <p className="text-muted-foreground text-xs">正在检测 ffmpeg…</p>;

  const warning = mediaToolsWarning(info);
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-xs">
      {warning === null ? (
        <div className="grid grid-cols-[8rem_1fr] gap-y-1">
          <span className="text-muted-foreground">状态</span>
          <span>可用（{MEDIA_TOOL_SOURCES[info.ffmpeg?.source ?? 'path']}）</span>
          <span className="text-muted-foreground">ffmpeg</span>
          <span className="break-all font-mono">{info.ffmpeg?.path}</span>
          <span className="text-muted-foreground">ffprobe</span>
          <span className="break-all font-mono">{info.ffprobe?.path}</span>
        </div>
      ) : (
        <p className="text-destructive">{warning}</p>
      )}
    </div>
  );
}

/**
 * The licences that ship inside the app (M7-9).
 *
 * Read through the preload bridge rather than fetched: these are files in the
 * app bundle, not something the daemon serves, and the one shown is the one
 * that was actually delivered — not what the repo says today.
 */
export function LegalBlock(): React.JSX.Element {
  const [shown, setShown] = useState<LegalDocument | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const open = async (document: LegalDocument): Promise<void> => {
    if (shown === document) {
      setShown(null);
      return;
    }
    setShown(document);
    setLoading(true);
    try {
      setText(await window.larkAPI.readLegal(document));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2 text-xs">
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => void open('license')}>
          许可证
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void open('notices')}>
          第三方软件声明
        </Button>
      </div>
      {shown !== null && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border p-3 font-mono text-[11px] leading-relaxed">
          {loading
            ? '读取中…'
            : // Absent is reported rather than rendered as an empty box: in a
              // packaged build this cannot happen (the release gate checks),
              // so seeing it means something is genuinely wrong.
              (text ??
              '这份文档不在应用包内。开发态可以先跑 `node scripts/gen-notices.mjs bundled` 生成。')}
        </pre>
      )}
    </div>
  );
}
