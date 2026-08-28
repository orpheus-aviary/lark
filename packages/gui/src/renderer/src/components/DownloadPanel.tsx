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
//
// THE FIRST TWO SECTIONS ARE TASKS AND THE THIRD IS RECORDS (0.5.0 P8c). They
// used to be one list filtered three ways, and the cost of that was written on
// the dialog itself: 「这次运行里已经结束的任务」. A download that failed while
// the app was closed had no answer at all. `已结束` now reads the daemon's
// file, which is where the phone has read it since 0.1.1 ⑦.

import { type DownloadRecord, canRetry, failedRecords, planRetry } from '@lark/core/portable';
import type { DownloadOrigin, DownloadTaskData, DownloadTaskKind } from '@lark/shared';
import {
  KIND_LABELS,
  STATE_LABELS,
  batchProgress,
  inputLabel,
  originCopyText,
  originLabel,
  taskDescription,
  taskLabel,
  taskTitle,
} from '@lark/shared';
import { Copy, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/errors.js';
import { loadNamingMode } from '../lib/naming-mode.js';
import { useDownloads } from '../stores/download.js';
import { useLibrary } from '../stores/library.js';
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

/**
 * Each section is ordered by the question it answers.
 *
 * The two live sections read as a queue — first in, top of the list — so a
 * batch of forty appears in the order it was submitted and a row does not move
 * while you look at it. The record is a log instead, newest first, and it
 * arrives that way: `ordered()` in portable is where that is decided, once,
 * for both hosts.
 *
 * The fallback matters for the tie: a queued task has no `started_at`, and
 * `created_at` keeps those in submission order rather than collapsing them all
 * to zero.
 */
const byQueueOrder = (a: DownloadTaskData, b: DownloadTaskData): number =>
  (a.started_at ?? a.created_at) - (b.started_at ?? b.created_at);

interface DownloadPanelProps {
  open: boolean;
  onClose: () => void;
}

export function DownloadPanel({ open, onClose }: DownloadPanelProps): React.JSX.Element {
  const tasks = useDownloads((s) => s.tasks);
  const batches = useDownloads((s) => s.batches);
  const cancelling = useDownloads((s) => s.cancelling);
  const history = useDownloads((s) => s.history);
  const cancel = useDownloads((s) => s.cancel);
  const cancelAll = useDownloads((s) => s.cancelAll);
  const refreshHistory = useDownloads((s) => s.refreshHistory);
  const clearHistory = useDownloads((s) => s.clearHistory);
  const forgetHistory = useDownloads((s) => s.forgetHistory);
  const downloadSong = useDownloads((s) => s.downloadSong);
  const redownload = useLibrary((s) => s.redownload);
  const redownloadLyrics = useLibrary((s) => s.redownloadLyrics);
  const playlists = usePlaylists((s) => s.playlists);
  /** One retry at a time, whether it came from a row or from 全部重试. */
  const [retrying, setRetrying] = useState(false);

  const playlistName = (id: string): string =>
    playlists.find((playlist) => playlist.id === id)?.name ?? id;

  const running = tasks.filter((task) => task.state === 'running').sort(byQueueOrder);
  const queued = tasks.filter((task) => task.state === 'queued').sort(byQueueOrder);

  // Read when the panel opens. The store also refetches on every terminal
  // event, but a window that was closed while a download finished has to catch
  // up on the way in.
  useEffect(() => {
    if (open) refreshHistory();
  }, [open, refreshHistory]);

  async function onCancel(taskId: string): Promise<void> {
    try {
      await cancel(taskId);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const failed = failedRecords(history);

  /**
   * Run one record again (P8d).
   *
   * The desktop's replay is the easy half of the phone's: `record.input` goes
   * straight back to the daemon, which owns the recogniser — no local parse,
   * no second set of refusals.
   *
   * 🔴 THE OLD ROW IS DELETED, and only after the daemon has taken the new
   * task: a download occupies one row, and that row is the LAST attempt. If
   * the request fails, the row it came from is still there to press again.
   *
   * The naming mode is whatever is chosen NOW. A record does not carry one
   * (`DownloadTaskData` has no such field), and the phone settled this in
   * 0.1.1 ⑨: a button pressed today means today's answer.
   */
  async function runAgain(record: DownloadRecord): Promise<void> {
    const plan = planRetry(record);
    if (plan.kind === 'redownload') {
      await redownload(plan.songId);
    } else if (plan.kind === 'lyrics') {
      await redownloadLyrics(plan.songId);
    } else {
      // One target, because `POST /download/song` takes one. A record with
      // several came from requests the engine merged, and the first is the
      // one this row was created for.
      await downloadSong(
        plan.text,
        plan.playlistIds[0],
        record.input.type === 'keyword' ? undefined : loadNamingMode(),
      );
    }
    await forgetHistory(record.id);
  }

  async function onRetry(record: DownloadRecord): Promise<void> {
    if (retrying) return;
    setRetrying(true);
    try {
      await runAgain(record);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRetrying(false);
    }
  }

  /** 全部重试: the failures only, one at a time, and it says how far it got. */
  async function onRetryAll(): Promise<void> {
    if (retrying || failed.length === 0) return;
    setRetrying(true);
    let done = 0;
    try {
      for (const record of failed) {
        await runAgain(record);
        done++;
      }
      toast.success(`已重新排队 ${done} 个`);
    } catch (err) {
      toast.error(`已重新排队 ${done}/${failed.length}：${errorMessage(err)}`);
    } finally {
      setRetrying(false);
    }
  }

  /** 清除记录: a DELETE now, not a list this window keeps to itself. */
  async function onClearHistory(): Promise<void> {
    try {
      await clearHistory();
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

  /** The one place a source reaches the clipboard, so it says so once. */
  function copySource(text: string): void {
    void navigator.clipboard?.writeText(text).then(
      () => toast.success('已复制来源'),
      () => toast.error('复制失败'),
    );
  }

  /**
   * The four lines every row has, whichever of the two it is.
   *
   * A live task and a finished record are different objects with the same
   * face: the name, what state it is in, where it came from, and what went
   * wrong. Written once here so the two callers cannot drift into showing
   * different things about the same download.
   */
  function rowBody(entry: {
    kind: DownloadTaskKind;
    name: string;
    artist: string | null;
    origin: DownloadOrigin;
    status: React.ReactNode;
    errorMessage: string | null;
    failedPlaylistIds: readonly string[];
    copyLabel: string;
  }): React.JSX.Element {
    const copyText = originCopyText(entry.origin);
    return (
      <div className="min-w-0 flex-1">
        <p className="truncate">
          {KIND_LABELS[entry.kind] !== null && (
            // A download and the lyrics fetch it spawns are two tasks about
            // one song: without this they are the same row twice.
            <span className="mr-1 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
              {KIND_LABELS[entry.kind]}
            </span>
          )}
          {entry.name}
          {entry.artist !== null && entry.artist !== '' && (
            <span className="text-muted-foreground"> · {entry.artist}</span>
          )}
        </p>
        <p className="text-muted-foreground tabular-nums">{entry.status}</p>
        {/* ④ — where this came from, on every row. A collection names the
            collection and counts the entry inside it; the button beside it
            copies THIS video, which is the link that reproduces the song.
            A task that started from a song in the library has no link to
            give, so it gets the line and no button. */}
        <p className="flex items-center gap-1 text-muted-foreground">
          <span className="truncate">{originLabel(entry.origin)}</span>
          {copyText !== null && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`复制来源 ${entry.copyLabel}`}
              title="复制来源"
              onClick={() => copySource(copyText)}
            >
              <Copy />
            </Button>
          )}
        </p>
        {entry.errorMessage !== null && <p className="text-destructive">{entry.errorMessage}</p>}
        {entry.failedPlaylistIds.length > 0 && (
          // Soft failure: the song downloaded, but these targets did not take
          // it (M3-7).
          <p className="text-amber-600 dark:text-amber-500">
            未能加入歌单：{entry.failedPlaylistIds.map(playlistName).join('、')}
          </p>
        )}
      </div>
    );
  }

  function row(task: DownloadTaskData): React.JSX.Element {
    const progress = batchProgress(batches, task.id);
    const pendingCancel = cancelling.includes(task.id);
    return (
      // The input stays reachable as the tooltip: once a link has a name, the
      // name is what the row is about, but "which link was that?" is still a
      // fair question.
      <li
        key={task.id}
        title={inputLabel(task.input)}
        className="flex items-start gap-2 px-3 py-2 text-xs"
      >
        {rowBody({
          kind: task.kind,
          name: taskTitle(task),
          artist: task.artist,
          origin: task.origin,
          status: (
            <>
              {taskLabel(task)}
              {pendingCancel && isActive(task) && ' · 取消中'}
              {progress && ` · ${progress.done}/${progress.batch.total}`}
            </>
          ),
          errorMessage: task.error_message,
          failedPlaylistIds: task.failed_playlist_ids,
          copyLabel: taskDescription(task),
        })}
        {isActive(task) && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`取消任务 ${taskDescription(task)}`}
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

  /** One finished download, from the file. Already newest-first (`ordered`). */
  function recordRow(record: DownloadRecord): React.JSX.Element {
    const name = record.title ?? inputLabel(record.input);
    const kind = KIND_LABELS[record.kind];
    return (
      <li
        key={record.id}
        title={inputLabel(record.input)}
        className="flex items-start gap-2 px-3 py-2 text-xs"
      >
        {rowBody({
          kind: record.kind,
          name,
          artist: record.artist,
          origin: record.origin ?? { kind: 'song', song_id: record.song_id ?? '' },
          status: STATE_LABELS[record.state],
          errorMessage: record.error_message,
          failedPlaylistIds: record.failed_playlist_ids ?? [],
          copyLabel: kind === null ? name : `${kind} ${name}`,
        })}
        {/* NOT on the successes, and the reason is not that re-fetching one is
            wrong: the song's own ⋮ menu already carries 重新下载, and a second
            door to one action is two places to keep in step. `canRetry` is
            portable's, so this row and the phone's offer it on the same set. */}
        {canRetry(record) && (
          <Button
            variant="ghost"
            size="xs"
            disabled={retrying}
            aria-label={`重下 ${name}`}
            onClick={() => void onRetry(record)}
          >
            重下
          </Button>
        )}
      </li>
    );
  }

  function section(
    title: string,
    count: number,
    rows: React.ReactNode,
    action?: React.ReactNode,
  ): React.JSX.Element | null {
    if (count === 0) return null;
    return (
      <section className="rounded-md border">
        <header className="flex items-center gap-2 rounded-t-md bg-muted px-3 py-1.5 text-sm">
          {/* A heading, not a styled span: "排队中" is also what a queued task's
              own status line says, and the two need to stay tellable apart —
              by a screen reader and by a test. */}
          <h3 className="font-medium">{title}</h3>
          <span className="text-muted-foreground text-xs">({count})</span>
          {action}
        </header>
        <ul className="divide-y">{rows}</ul>
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
          <DialogDescription>正在进行、排队中，以及已经结束的下载记录。</DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-3 overflow-y-auto">
          {tasks.length === 0 && history.length === 0 && (
            <p className="py-10 text-center text-muted-foreground text-sm">暂无任务</p>
          )}
          {section('进行中', running.length, running.map(row))}
          {section('排队中', queued.length, queued.map(row))}
          {section(
            '已结束',
            history.length,
            history.map(recordRow),
            failed.length > 0 && (
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto"
                disabled={retrying}
                onClick={() => void onRetryAll()}
              >
                全部重试 {failed.length}
              </Button>
            ),
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={history.length === 0}
            onClick={() => void onClearHistory()}
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
