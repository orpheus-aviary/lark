// The download input and its status line (D17), plus the entry points to the
// paste box (D19) and the task list (D18).
//
// One line of paste decides the flow: `POST /download/parse` recognises what
// it is without queueing anything, a lone video or keyword goes straight to
// `POST /download/song`, and anything else opens the selection dialog.

import type { ParsedItem } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { ListChecks, Loader2, Maximize2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { taskLabel } from '../lib/download-labels.js';
import { errorMessage } from '../lib/errors.js';
import { activeTask, batchProgress, useDownloads } from '../stores/download.js';
import { useLibrary } from '../stores/library.js';
import { BatchActionBar } from './BatchActionBar.js';
import { BatchSelectModal } from './BatchSelectModal.js';
import { DownloadTasksPopover } from './DownloadTasksPopover.js';
import { PasteInputModal } from './PasteInputModal.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';

/** Go parity: a finished line lingers, a failed one lingers longer. */
const NOTICE_MS = { ok: 5000, error: 15_000 } as const;

interface Notice {
  text: string;
  error: boolean;
}

interface DownloadBarProps {
  /** Rendered at the end of the input row; the sort control in practice. */
  trailing?: React.ReactNode;
}

export function DownloadBar({ trailing }: DownloadBarProps = {}): React.JSX.Element {
  const tasks = useDownloads((s) => s.tasks);
  const batches = useDownloads((s) => s.batches);
  const cancelling = useDownloads((s) => s.cancelling);
  const parse = useDownloads((s) => s.parse);
  const downloadSong = useDownloads((s) => s.downloadSong);
  const cancel = useDownloads((s) => s.cancel);
  const playlistId = useLibrary((s) => s.playlistId);

  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [batchItems, setBatchItems] = useState<readonly ParsedItem[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.error ? NOTICE_MS.error : NOTICE_MS.ok);
    return () => clearTimeout(timer);
  }, [notice]);

  /** §4.1: `all` is not a target — the song is only added to the library. */
  const targetPlaylist = playlistId === VIRTUAL_ALL_PLAYLIST_ID ? undefined : playlistId;

  async function submit(text: string): Promise<void> {
    const input = text.trim();
    if (input === '' || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const { items } = await parse(input);
      if (items.length === 0) {
        setNotice({ text: '未识别到有效的下载项', error: true });
        return;
      }
      const only = items[0];
      if (items.length === 1 && only && (only.kind === 'video' || only.kind === 'keyword')) {
        // `input` for a video is the NORMALISED url parse handed back (it keeps
        // `?p=`), and for a keyword the query itself (§4.2).
        await downloadSong(only.kind === 'video' ? only.url : only.query, targetPlaylist);
        setValue('');
        return;
      }
      setBatchItems(items);
      setValue('');
    } catch (err) {
      setNotice({ text: errorMessage(err), error: true });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  const current = activeTask(tasks);
  const progress = current ? batchProgress(batches, current.id) : null;
  const isCancelling = current !== null && cancelling.includes(current.id);
  // A task in `saving` has passed the point where aborting helps (M3 contract).
  const cancellable = current !== null && current.stage !== 'saving' && !isCancelling;

  async function cancelCurrent(): Promise<void> {
    if (!current) return;
    try {
      await cancel(current.id);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          aria-label="下载链接或歌曲名称"
          placeholder="输入链接或歌曲名称下载…"
          className="h-8"
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit(value);
          }}
        />
        <Button
          variant="secondary"
          size="icon-sm"
          aria-label="批量下载"
          title="批量下载"
          onClick={() => setPasteOpen(true)}
        >
          <Maximize2 />
        </Button>
        <DownloadTasksPopover>
          <Button variant="secondary" size="icon-sm" aria-label="下载任务" title="下载任务">
            <ListChecks />
          </Button>
        </DownloadTasksPopover>
        {trailing}
      </div>

      {/* Always rendered at a FIXED height, even when idle: the song list is
          the flex child that absorbs the leftover height, so a status line
          that appears, disappears or grows would make the whole table jump.
          28px rather than 20 because the batch-action bar shares this row and
          its buttons are 24px tall. */}
      <div className="flex h-7 items-center gap-1.5 text-xs">
        {/* Download status on the left, batch actions pinned to the right —
            they share the row rather than taking turns, so neither can hide
            the other (revised B-5). */}
        {(busy || current) && (
          <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
        )}
        <span
          className={`truncate ${notice?.error ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {busy
            ? '正在解析输入…'
            : current
              ? `${taskLabel(current)}${isCancelling ? '（取消中）' : ''}`
              : (notice?.text ?? '')}
        </span>
        {progress && (
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {progress.done}/{progress.batch.total}
          </span>
        )}
        {current && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="取消下载"
            title={cancellable ? '取消下载' : '当前阶段不可取消'}
            disabled={!cancellable}
            onClick={() => void cancelCurrent()}
          >
            <X />
          </Button>
        )}
        <BatchActionBar />
      </div>

      {pasteOpen && (
        <PasteInputModal
          onClose={() => setPasteOpen(false)}
          onConfirm={(text) => {
            setPasteOpen(false);
            void submit(text);
          }}
        />
      )}
      {batchItems && <BatchSelectModal items={batchItems} onClose={() => setBatchItems(null)} />}
    </div>
  );
}
