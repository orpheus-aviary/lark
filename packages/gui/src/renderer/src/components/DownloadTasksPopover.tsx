// The task list (D18). The Go version had no such view: with one status line
// a batch's per-item outcome, and the soft playlist failures M3-7 kept in
// `failed_playlist_ids`, had nowhere to be said out loud.

import type { DownloadTaskData } from '@lark/shared';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { inputLabel, taskLabel } from '../lib/download-labels.js';
import { errorMessage } from '../lib/errors.js';
import { batchProgress, useDownloads } from '../stores/download.js';
import { usePlaylists } from '../stores/playlists.js';
import { Button } from './ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

function isActive(task: DownloadTaskData): boolean {
  return task.state === 'queued' || task.state === 'running';
}

export function DownloadTasksPopover({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const tasks = useDownloads((s) => s.tasks);
  const batches = useDownloads((s) => s.batches);
  const cancelling = useDownloads((s) => s.cancelling);
  const cancel = useDownloads((s) => s.cancel);
  const refresh = useDownloads((s) => s.refresh);
  const playlists = usePlaylists((s) => s.playlists);

  const playlistName = (id: string): string =>
    playlists.find((playlist) => playlist.id === id)?.name ?? id;

  async function onCancel(taskId: string): Promise<void> {
    try {
      await cancel(taskId);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Popover
      onOpenChange={(open) => {
        // The snapshot is the only place terminal detail lives, and the ring
        // ages tasks out — so it is refetched when the list is opened.
        if (open) refresh();
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="border-b px-3 py-2 font-medium text-sm">下载任务</div>
        <ul className="max-h-96 divide-y overflow-y-auto">
          {tasks.length === 0 && (
            <li className="px-3 py-6 text-center text-muted-foreground text-sm">暂无任务</li>
          )}
          {tasks.map((task) => {
            const progress = batchProgress(batches, task.id);
            const pendingCancel = cancelling.includes(task.id);
            return (
              <li key={task.id} className="flex items-start gap-2 px-3 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <p className="truncate">{inputLabel(task.input)}</p>
                  <p className="text-muted-foreground">
                    {taskLabel(task)}
                    {pendingCancel && isActive(task) && ' · 取消中'}
                    {progress && ` · ${progress.done}/${progress.batch.total}`}
                  </p>
                  {task.error_message !== null && (
                    <p className="text-destructive">{task.error_message}</p>
                  )}
                  {task.failed_playlist_ids.length > 0 && (
                    // Soft failure: the song downloaded, but these targets did
                    // not take it (M3-7).
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
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
