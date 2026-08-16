// The download panel (D18, reworked in 0.3.0 §3.6-3).
//
// It replaced a popover, and the reason is the content rather than the taste:
// a transfer now reports bytes, a queue can be three hundred long, and the
// terminal records are the only place a batch's per-item outcome — and the
// soft playlist failures M3-7 keeps in `failed_playlist_ids` — is ever said
// out loud. None of that reads well in a 96-unit popover anchored to a button.
//
// Three sections, because the three answer different questions: what is
// happening now, what is waiting, and what already happened. The vocabulary is
// frozen (§3.6-3): a task is CANCELLED, a record is CLEARED, and deleting a
// song is not something this panel does at all.

import type { DownloadTaskData } from '@lark/shared';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { inputLabel, taskLabel } from '../lib/download-labels.js';
import { errorMessage } from '../lib/errors.js';
import { batchProgress, useDownloads } from '../stores/download.js';
import { usePlaylists } from '../stores/playlists.js';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

function isActive(task: DownloadTaskData): boolean {
  return task.state === 'queued' || task.state === 'running';
}

interface DownloadPanelProps {
  open: boolean;
  onClose: () => void;
}

export function DownloadPanel({ open, onClose }: DownloadPanelProps): React.JSX.Element {
  const tasks = useDownloads((s) => s.tasks);
  const batches = useDownloads((s) => s.batches);
  const cancelling = useDownloads((s) => s.cancelling);
  const dismissed = useDownloads((s) => s.dismissed);
  const cancel = useDownloads((s) => s.cancel);
  const cancelAll = useDownloads((s) => s.cancelAll);
  const dismissTerminal = useDownloads((s) => s.dismissTerminal);
  const playlists = usePlaylists((s) => s.playlists);

  const playlistName = (id: string): string =>
    playlists.find((playlist) => playlist.id === id)?.name ?? id;

  const visible = tasks.filter((task) => !dismissed.includes(task.id));
  const running = visible.filter((task) => task.state === 'running');
  const queued = visible.filter((task) => task.state === 'queued');
  const finished = visible.filter((task) => !isActive(task));

  async function onCancel(taskId: string): Promise<void> {
    try {
      await cancel(taskId);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  /**
   * "Cancel every task", reported honestly: the daemon answers per task, and
   * the ones it could not stop are the ones already past the commit point —
   * which is a finished download, not a failure to obey.
   */
  async function onCancelAll(): Promise<void> {
    try {
      const result = await cancelAll();
      const refused = result.results.filter((entry) => entry.error_code !== null).length;
      toast.success(
        refused === 0
          ? `已取消 ${result.results.length} 个任务`
          : `已取消 ${result.results.length - refused} 个任务，${refused} 个已经过了可取消的阶段`,
      );
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function row(task: DownloadTaskData): React.JSX.Element {
    const progress = batchProgress(batches, task.id);
    const pendingCancel = cancelling.includes(task.id);
    return (
      <li key={task.id} className="flex items-start gap-2 px-3 py-2 text-xs">
        <div className="min-w-0 flex-1">
          <p className="truncate">{inputLabel(task.input)}</p>
          <p className="text-muted-foreground tabular-nums">
            {taskLabel(task)}
            {pendingCancel && isActive(task) && ' · 取消中'}
            {progress && ` · ${progress.done}/${progress.batch.total}`}
          </p>
          {task.error_message !== null && <p className="text-destructive">{task.error_message}</p>}
          {task.failed_playlist_ids.length > 0 && (
            // Soft failure: the song downloaded, but these targets did not take
            // it (M3-7).
            <p className="text-amber-600 dark:text-amber-500">
              未能加入歌单：{task.failed_playlist_ids.map(playlistName).join('、')}
            </p>
          )}
        </div>
        {isActive(task) && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`取消任务 ${inputLabel(task.input)}`}
            title={task.stage === 'saving' ? '当前阶段不可取消' : '取消任务'}
            disabled={task.stage === 'saving' || pendingCancel}
            onClick={() => void onCancel(task.id)}
          >
            <X />
          </Button>
        )}
      </li>
    );
  }

  function section(title: string, of: readonly DownloadTaskData[]): React.JSX.Element | null {
    if (of.length === 0) return null;
    return (
      <section className="rounded-md border">
        <header className="flex items-center gap-2 rounded-t-md bg-muted px-3 py-1.5 text-sm">
          {/* A heading, not a styled span: "排队中" is also what a queued task's
              own status line says, and the two need to stay tellable apart —
              by a screen reader and by a test. */}
          <h3 className="font-medium">{title}</h3>
          <span className="text-muted-foreground text-xs">({of.length})</span>
        </header>
        <ul className="divide-y">{of.map(row)}</ul>
      </section>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-160">
        <DialogHeader>
          <DialogTitle>下载任务</DialogTitle>
          <DialogDescription>正在进行、排队中，以及这次运行里已经结束的任务。</DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-3 overflow-y-auto">
          {visible.length === 0 && (
            <p className="py-10 text-center text-muted-foreground text-sm">暂无任务</p>
          )}
          {section('进行中', running)}
          {section('排队中', queued)}
          {section('已结束', finished)}
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={finished.length === 0}
            onClick={() => dismissTerminal()}
          >
            清除记录
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={running.length + queued.length === 0}
            onClick={() => void onCancelAll()}
          >
            全部取消
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
