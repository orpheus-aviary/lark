// The download input and its status line (D17), plus the entry points to the
// paste box (D19) and the task list (D18).
//
// One line of paste decides the flow: `POST /download/parse` recognises what
// it is without queueing anything, a lone video or keyword goes straight to
// `POST /download/song`, and anything else opens the selection dialog.

import type { DownloadNamingMode, ParsedItem } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { ListChecks, Loader2, Maximize2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { inputLabel, taskDescription, taskLabel } from '../lib/download-labels.js';
import { errorMessage } from '../lib/errors.js';
import { loadNamingMode, rememberNamingMode } from '../lib/naming-mode.js';
import { activeTask, batchProgress, useDownloads } from '../stores/download.js';
import { useLibrary } from '../stores/library.js';
import { mediaToolsWarning, useMediaTools } from '../stores/media-tools.js';
import { BatchActionBar } from './BatchActionBar.js';
import { BatchSelectModal } from './BatchSelectModal.js';
import { DownloadPanel } from './DownloadPanel.js';
import { NamingModeDialog } from './NamingModeDialog.js';
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
  const refresh = useDownloads((s) => s.refresh);
  const playlistId = useLibrary((s) => s.playlistId);
  const mediaTools = useMediaTools((s) => s.info);
  const llmAvailable = useMediaTools((s) => s.llmAvailable);
  const refreshMediaTools = useMediaTools((s) => s.refresh);

  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [batchItems, setBatchItems] = useState<readonly ParsedItem[] | null>(null);
  // A lone video link, waiting for its naming answer. Held rather than
  // downloaded immediately because the answer is the user's, not a default.
  const [pendingVideo, setPendingVideo] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.error ? NOTICE_MS.error : NOTICE_MS.ok);
    return () => clearTimeout(timer);
  }, [notice]);

  // Asked once at startup. The settings dialog re-asks on every open, which is
  // where a user goes after installing ffmpeg.
  useEffect(() => {
    refreshMediaTools();
  }, [refreshMediaTools]);

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
      if (items.length === 1 && only?.kind === 'keyword') {
        // A keyword has no title to keep, so there is nothing to ask: the model
        // names it either way, and `naming_mode` on one is refused (§3.6-1).
        await downloadSong(only.query, targetPlaylist);
        setValue('');
        return;
      }
      if (items.length === 1 && only?.kind === 'video') {
        // `input` is the NORMALISED url parse handed back (it keeps `?p=`).
        setPendingVideo(only.url);
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
  // "Behind this one": when nothing is running, `activeTask` shows the head of
  // the queue, and counting it as waiting would say 3 while showing one of the
  // three.
  const queuedAhead =
    tasks.filter((task) => task.state === 'queued').length - (current?.state === 'queued' ? 1 : 0);
  const isCancelling = current !== null && cancelling.includes(current.id);
  const toolsWarning = mediaToolsWarning(mediaTools);
  const showsError = notice?.error === true || (!busy && current === null && toolsWarning !== null);
  // A task in `saving` has passed the point where aborting helps (M3 contract).
  const cancellable = current !== null && current.stage !== 'saving' && !isCancelling;

  /** The second half of `submit` for a video: run once the naming is known. */
  async function startVideo(url: string, naming: DownloadNamingMode): Promise<void> {
    setBusy(true);
    try {
      await downloadSong(url, targetPlaylist, naming);
    } catch (err) {
      setNotice({ text: errorMessage(err), error: true });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

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
        <Button
          variant="secondary"
          size="icon-sm"
          aria-label="下载任务"
          title="下载任务"
          onClick={() => {
            // The snapshot is the only place terminal detail lives, and the
            // ring ages tasks out — so it is refetched when the panel opens.
            refresh();
            setPanelOpen(true);
          }}
        >
          <ListChecks />
        </Button>
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
        {/* The ffmpeg warning takes the idle slot rather than a line of its
            own: this row has a fixed height on purpose, and every download
            from here fails without it, so an empty status line is the wrong
            thing to show (M7-18). Anything actually happening outranks it. */}
        {current && (
          // Which song, in a FIXED width. A queued link has no name yet, so
          // this is a raw bilibili URL often enough that letting it size itself
          // would push the stage, the queue count and the cancel button off the
          // row. The whole input stays in the tooltip.
          <span className="max-w-56 shrink-0 truncate" title={inputLabel(current.input)}>
            {taskDescription(current)}
          </span>
        )}
        <span className={`truncate ${showsError ? 'text-destructive' : 'text-muted-foreground'}`}>
          {busy
            ? '正在解析输入…'
            : current
              ? `${taskLabel(current)}${isCancelling ? '（取消中）' : ''}`
              : (notice?.text ?? toolsWarning ?? '')}
        </span>
        {progress && (
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {progress.done}/{progress.batch.total}
          </span>
        )}
        {queuedAhead > 0 && (
          // What the row cannot show otherwise: one line reports one task, and
          // "is anything else waiting?" is the other question people have.
          <span className="shrink-0 text-muted-foreground tabular-nums">
            还有 {queuedAhead} 个排队
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
      <DownloadPanel open={panelOpen} onClose={() => setPanelOpen(false)} />
      <NamingModeDialog
        open={pendingVideo !== null}
        count={1}
        value={loadNamingMode()}
        // `null` is "not answered yet", and greying out the option a daemon
        // has not been asked about would be a lie in the other direction.
        llmAvailable={llmAvailable !== false}
        onCancel={() => setPendingVideo(null)}
        onConfirm={(mode) => {
          const url = pendingVideo;
          setPendingVideo(null);
          if (url === null) return;
          rememberNamingMode(mode);
          void startVideo(url, mode);
        }}
      />
    </div>
  );
}
