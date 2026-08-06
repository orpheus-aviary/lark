// Importing a playlist file (M5-13 / M5-15).
//
// Two requests, and the gap between them is the whole design. The preview
// reads the file and says what would happen; the commit reads it AGAIN and
// refuses if a single byte changed, because `reuse[].index` points into the
// file the user was looking at. So this dialog holds the digest, not a parsed
// copy of the file, and a changed file sends the user back to the preview.
//
// The suspect list defaults to "import as a new song" on purpose: same
// name+artist under a different key is a live cut or a remix at least as often
// as it is a duplicate, and a wrong merge is not undoable (R12).

import type {
  PlaylistImportData,
  PlaylistImportPreviewData,
  PlaylistImportTarget,
} from '@lark/shared';
import { API_PATHS, ApiError, VIRTUAL_ALL_PLAYLIST_ID, request } from '@lark/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/errors.js';
import { getPlatform } from '../platform/index.js';
import { useLibrary } from '../stores/library.js';
import { usePlaylists, userPlaylists } from '../stores/playlists.js';
import { Button } from './ui/button.js';
import { Checkbox } from './ui/checkbox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js';

/** Sentinel target values; every other value is a real playlist id. */
const TARGET_ALL = VIRTUAL_ALL_PLAYLIST_ID;
const TARGET_NEW = '__new__';

interface ImportPlaylistDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ImportPlaylistDialog({
  open,
  onClose,
}: ImportPlaylistDialogProps): React.JSX.Element {
  const playlists = usePlaylists((s) => s.playlists);
  const refreshPlaylists = usePlaylists((s) => s.refresh);

  const [filePath, setFilePath] = useState<string | null>(null);
  const [preview, setPreview] = useState<PlaylistImportPreviewData | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<string>(TARGET_NEW);
  const [newName, setNewName] = useState('');
  /** Suspect index → the song it should merge into. Absent = import as new. */
  const [merges, setMerges] = useState<Record<number, string>>({});

  const reset = (): void => {
    setFilePath(null);
    setPreview(null);
    setMerges({});
    setTarget(TARGET_NEW);
    setNewName('');
  };

  const close = (): void => {
    reset();
    onClose();
  };

  /** Read the file the user picked (or re-read the current one). */
  const runPreview = async (path: string): Promise<void> => {
    setBusy(true);
    try {
      const envelope = await request<PlaylistImportPreviewData>(
        'POST',
        API_PATHS.playlistImportPreview,
        { file_path: path },
      );
      const data = envelope.data;
      if (data === undefined) throw new Error('预览返回为空');
      setFilePath(path);
      setPreview(data);
      setMerges({});
      setNewName(data.playlist_name);
    } catch (err) {
      setFilePath(null);
      setPreview(null);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async (): Promise<void> => {
    const path = await getPlatform().pickJsonFile();
    if (path === null) return;
    await runPreview(path);
  };

  const toTarget = (): PlaylistImportTarget | null => {
    if (target === TARGET_ALL) return { kind: 'all' };
    if (target !== TARGET_NEW) return { kind: 'playlist', playlist_id: target };
    const name = newName.trim();
    return name === '' ? null : { kind: 'new', name };
  };

  const submit = async (): Promise<void> => {
    if (preview === null || filePath === null) return;
    const chosenTarget = toTarget();
    if (chosenTarget === null) {
      toast.error('请填写新歌单的名称');
      return;
    }

    setBusy(true);
    try {
      const envelope = await request<PlaylistImportData>('POST', API_PATHS.playlistImport, {
        file_path: filePath,
        digest: preview.digest,
        target: chosenTarget,
        reuse: Object.entries(merges).map(([index, songId]) => ({
          index: Number(index),
          song_id: songId,
        })),
      });
      const data = envelope.data;
      toast.success(
        data === undefined
          ? '导入完成'
          : `导入完成：新建 ${data.created} 首，复用 ${data.reused} 首`,
      );
      refreshPlaylists();
      const library = useLibrary.getState();
      if (data?.playlist_id != null) library.setPlaylistId(data.playlist_id);
      else library.refresh();
      close();
    } catch (err) {
      toast.error(errorMessage(err));
      // The file moved under us: the indices this dialog holds no longer mean
      // anything, so re-read it rather than letting the user retry blind. The
      // code says so — the message is never parsed (M5-20).
      if (err instanceof ApiError && err.errorCode === 'IMPORT_SOURCE_CHANGED') {
        void runPreview(filePath);
      }
    } finally {
      setBusy(false);
    }
  };

  const suspects = preview?.suspects ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-160">
        <DialogHeader>
          <DialogTitle>导入歌单</DialogTitle>
          <DialogDescription>
            按来源标识去重：同一个 B
            站视频只会复用库里已有的那首歌。导入的歌没有音频文件，播放时再下载。
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto">
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void pickFile()}>
              选择文件…
            </Button>
            <span className="truncate text-muted-foreground text-xs" title={filePath ?? ''}>
              {filePath ?? '尚未选择文件'}
            </span>
          </div>

          {preview !== null && (
            <>
              <p className="text-sm">
                共 {preview.total} 首：新建 <b>{preview.new_count}</b> 首，复用{' '}
                <b>{preview.reuse_count}</b> 首
              </p>

              {suspects.length > 0 && (
                <section className="rounded-md border">
                  <header className="rounded-t-md bg-muted px-3 py-2 text-sm">
                    疑似重复（{suspects.length}）
                    <span className="ml-1 text-muted-foreground text-xs">
                      默认导入为新条目；取消勾选可复用库里已有的歌
                    </span>
                  </header>
                  <ul className="max-h-56 space-y-1 overflow-y-auto p-2">
                    {suspects.map((suspect) => {
                      const merged = merges[suspect.index];
                      const checkboxId = `suspect-${suspect.index}`;
                      return (
                        <li key={suspect.index} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            id={checkboxId}
                            checked={merged === undefined}
                            onCheckedChange={() =>
                              setMerges((prev) => {
                                const next = { ...prev };
                                if (suspect.index in next) delete next[suspect.index];
                                else next[suspect.index] = suspect.candidates[0].id;
                                return next;
                              })
                            }
                          />
                          <label htmlFor={checkboxId} className="min-w-0 flex-1 truncate">
                            {suspect.name}
                            {suspect.artist === '' ? '' : ` — ${suspect.artist}`}
                          </label>
                          {merged !== undefined && suspect.candidates.length > 1 && (
                            <Select
                              value={merged}
                              onValueChange={(value) =>
                                setMerges((prev) => ({ ...prev, [suspect.index]: value }))
                              }
                            >
                              <SelectTrigger
                                className="h-7 w-44"
                                aria-label={`复用哪一首：${suspect.name}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {suspect.candidates.map((candidate) => (
                                  <SelectItem key={candidate.id} value={candidate.id}>
                                    {candidate.name}
                                    {candidate.artist === '' ? '' : ` — ${candidate.artist}`}
                                    {candidate.has_file ? '（有文件）' : ''}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              <div className="space-y-2">
                <Label htmlFor="import-target">导入到</Label>
                <Select value={target} onValueChange={setTarget}>
                  <SelectTrigger id="import-target">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={TARGET_NEW}>新建歌单…</SelectItem>
                    <SelectItem value={TARGET_ALL}>仅加入曲库</SelectItem>
                    {userPlaylists(playlists).map((playlist) => (
                      <SelectItem key={playlist.id} value={playlist.id}>
                        {playlist.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {target === TARGET_NEW && (
                  <Input
                    aria-label="新歌单名称"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="新歌单名称"
                  />
                )}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={close}>
            取消
          </Button>
          <Button size="sm" disabled={busy || preview === null} onClick={() => void submit()}>
            {busy ? '处理中…' : '导入'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
