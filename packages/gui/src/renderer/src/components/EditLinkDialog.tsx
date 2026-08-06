// Editing a song's source link (M5-11).
//
// The four save outcomes are the daemon's (`PUT /songs/:id` with url only):
// empty clears the whole triple, a bilibili link is normalised online (p → cid),
// a plain http(s) link is kept as-is with no identity, and anything else is a
// 400. This dialog adds the three things a bare form cannot do:
//
//   [自动识别] previews what a URL resolves to WITHOUT writing (R6),
//   a changed key on a song that has a file offers to refetch it,
//   and a 409 names the song that already owns the link — plus a way to get
//   to it, which needs a whole navigation sequence, not a selection: the
//   conflicting song may not be in the current playlist or search at all.

import type { SongData } from '@lark/shared';
import { ApiError, VIRTUAL_ALL_PLAYLIST_ID, apiPath, request } from '@lark/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/errors.js';
import { useLibrary } from '../stores/library.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import { Input } from './ui/input.js';

interface EditLinkDialogProps {
  song: SongData | null;
  onClose: () => void;
}

interface Conflict {
  songId: string;
  name: string;
}

/**
 * Show the conflicting song: switch to the whole library, drop the search,
 * wait for that view to land, then select and scroll to it. Setting
 * `selectedSongId` alone would point at a row that is not rendered.
 */
async function locateSong(songId: string): Promise<void> {
  const library = useLibrary.getState();
  library.setPlaylistId(VIRTUAL_ALL_PLAYLIST_ID);
  library.setSearch('');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const state = useLibrary.getState();
    if (!state.loading && state.songs.some((song) => song.id === songId)) {
      state.setSelectedSongId(songId);
      document.querySelector(`[data-testid="song-row-${songId}"]`)?.scrollIntoView({
        block: 'center',
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  toast.info('歌曲已不存在');
}

export function EditLinkDialog({ song, onClose }: EditLinkDialogProps): React.JSX.Element {
  const updateSong = useLibrary((s) => s.updateSong);
  const recognizeUrl = useLibrary((s) => s.recognizeUrl);
  const redownload = useLibrary((s) => s.redownload);

  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  /** Set after a successful save that changed the key of a song with a file. */
  const [offerRedownload, setOfferRedownload] = useState(false);

  // Re-seeded per song: the dialog is a singleton in the row's tree.
  useEffect(() => {
    setUrl(song?.source_url ?? '');
    setConflict(null);
    setOfferRedownload(false);
  }, [song]);

  const recognize = async (): Promise<void> => {
    if (song === null) return;
    setBusy(true);
    try {
      // A preview only — nothing is written until the user saves (R6).
      const preview = await recognizeUrl(song.id, url.trim());
      setUrl(preview.source_url);
      toast.success(`识别到：${preview.video_title}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (song === null) return;
    setBusy(true);
    setConflict(null);
    try {
      await updateSong(song.id, { source_url: url.trim() === '' ? null : url.trim() });
      // The key may have moved to a different video, in which case the file on
      // disk is no longer what the link points at.
      const fresh = await request<SongData>('GET', apiPath.song(song.id));
      const changedKey =
        fresh.data !== undefined && fresh.data.source_key !== song.source_key && song.has_file;
      toast.success(url.trim() === '' ? '已清除链接' : '链接已更新');
      if (changedKey === true) setOfferRedownload(true);
      else onClose();
    } catch (err) {
      if (err instanceof ApiError && err.errorCode === 'SOURCE_KEY_CONFLICT') {
        const conflictingId = err.details?.conflicting_song_id;
        if (typeof conflictingId === 'string') {
          setConflict({ songId: conflictingId, name: await songName(conflictingId) });
          return;
        }
      }
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmRedownload = (): void => {
    if (song === null) return;
    setOfferRedownload(false);
    onClose();
    void redownload(song.id).then(
      () => toast.success('已开始按新链接重新下载'),
      (err: unknown) => toast.error(errorMessage(err)),
    );
  };

  return (
    <>
      <Dialog open={song !== null && !offerRedownload} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="sm:max-w-120">
          <DialogHeader>
            <DialogTitle>编辑链接</DialogTitle>
            <DialogDescription>
              留空并保存会清除来源；B 站链接会联网规范化到具体分 P。
            </DialogDescription>
          </DialogHeader>

          <Input
            aria-label="来源链接"
            value={url}
            disabled={busy}
            placeholder="https://www.bilibili.com/video/BV..."
            onChange={(e) => setUrl(e.target.value)}
          />

          {conflict !== null && (
            <p className="text-destructive text-sm">
              该链接已属于《{conflict.name}》。
              <Button
                variant="link"
                size="sm"
                className="px-1"
                onClick={() => {
                  onClose();
                  void locateSong(conflict.songId);
                }}
              >
                定位
              </Button>
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void recognize()}>
              自动识别
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={offerRedownload}
        title="链接已换"
        description="这首歌的来源标识变了，现有文件可能不是新链接的内容。是否立即按新链接重新下载？"
        confirmLabel="重新下载"
        onConfirm={confirmRedownload}
        onCancel={() => {
          setOfferRedownload(false);
          onClose();
        }}
      />
    </>
  );
}

/** The conflicting song's name: the open view first, the daemon otherwise. */
async function songName(songId: string): Promise<string> {
  const known = useLibrary.getState().songs.find((song) => song.id === songId);
  if (known !== undefined) return known.name;
  try {
    const envelope = await request<SongData>('GET', apiPath.song(songId));
    return envelope.data?.name ?? songId;
  } catch {
    return songId;
  }
}
