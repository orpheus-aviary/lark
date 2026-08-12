// The file operations that gave up (v0.2 T4, R5-P1-1).
//
// Shared by the sync popover and the sync settings tab: both are legitimate
// places to meet a stuck file effect, and two copies of "retry / discard"
// would be two chances to get the destructive one wrong.
//
// Both exits are offered together on purpose — retry is cheap and usually
// right (a permission fixed, a disk remounted); discard destroys the effect
// for good, so the host confirms it and this component only asks.

import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/errors.js';
import { fileOpKindLabel } from '../lib/sync-labels.js';
import { useSync } from '../stores/sync.js';
import { Button } from './ui/button.js';

export function SyncFileOpsList({
  onDiscard,
}: {
  onDiscard: (id: number) => void;
}): React.JSX.Element {
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
    <div className="space-y-2 text-xs">
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

/** The sentence a discard is confirmed against, in both hosts. */
export const DISCARD_FILE_OP_DESCRIPTION =
  '放弃后这次文件操作永远不会执行：该删的文件会留下、该写的歌词不会写入，只在日志里留一条记录。确定吗？';
