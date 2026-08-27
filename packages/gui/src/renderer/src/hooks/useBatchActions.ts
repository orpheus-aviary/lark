// The actions a selection can take, shared by the two places that offer them:
// the status-line bar and the right-click menu (S3/B-4).
//
// Shared rather than duplicated because they must agree exactly — a menu that
// deleted one row while the bar deleted five would be the worst kind of bug,
// silent and destructive. The hook owns the requests, the counting and the
// toast; each caller renders its own confirmation, since the two live in
// different trees.

import type { PlaylistData } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { batchMessage, runBatch } from '../lib/batch-actions.js';
import { errorMessage } from '../lib/errors.js';
import { useLibrary } from '../stores/library.js';
import { usePlaylists, userPlaylists } from '../stores/playlists.js';

export interface BatchActions {
  /** How many rows the actions would apply to. */
  count: number;
  /** A batch is in flight; every entry point disables itself (B-12). */
  busy: boolean;
  /** Playlists a selection can be added to — never the virtual `all` (§4.1). */
  targets: readonly PlaylistData[];
  /** The playlist rows can be removed FROM, or null outside a member list. */
  removableFrom: string | null;
  pin: (pinned: boolean) => void;
  addTo: (playlist: PlaylistData) => void;
  removeFromCurrent: () => void;
  /**
   * The three that used to act on the right-clicked row alone (§7 F17).
   *
   * They are queue-and-forget on the daemon side (a redownload is a task), so
   * unlike pin/remove they change nothing the list is showing — the toast is
   * the whole feedback, and the selection stays as it was.
   */
  redownload: () => void;
  redownloadLyrics: () => void;
  deleteLyrics: () => void;
  /**
   * Fill in the audio the selection is missing — an ensure-file per row that
   * has no file, and NOTHING for the rows that do.
   *
   * Deliberately not `redownload` over the same selection (the only batch
   * download there was until now): that one refetches every row, so "download
   * this playlist" on a library that is mostly here would pay for all of it
   * again and rewrite files that were fine. The rows it skips are counted in
   * the toast rather than silently dropped.
   */
  download: () => void;
  /** Deletes without asking — the caller owns the confirmation (B-8). */
  deleteSelected: () => void;
}

export function useBatchActions(): BatchActions {
  const selectedIds = useLibrary((s) => s.selectedIds);
  const songs = useLibrary((s) => s.songs);
  const clearSelection = useLibrary((s) => s.clearSelection);
  const setPinned = useLibrary((s) => s.setPinned);
  const deleteSong = useLibrary((s) => s.deleteSong);
  const redownload = useLibrary((s) => s.redownload);
  const ensureFile = useLibrary((s) => s.ensureFile);
  const redownloadLyrics = useLibrary((s) => s.redownloadLyrics);
  const deleteLyrics = useLibrary((s) => s.deleteLyrics);
  const playlistId = useLibrary((s) => s.playlistId);
  const search = useLibrary((s) => s.search);
  const playlists = usePlaylists((s) => s.playlists);
  const addSongs = usePlaylists((s) => s.addSongs);
  const removeSong = usePlaylists((s) => s.removeSong);

  const [busy, setBusy] = useState(false);

  // Same rule as the single-row menu: a search result is not a member list.
  const removableFrom = search === '' && playlistId !== VIRTUAL_ALL_PLAYLIST_ID ? playlistId : null;

  /** One action across the selection, reported by what actually happened. */
  const run = (
    verb: string,
    action: (id: string) => Promise<void>,
    options: { clearAfter?: boolean; ids?: readonly string[]; note?: string } = {},
  ): void => {
    // The ids are captured now: the list may refresh mid-batch.
    const ids = [...(options.ids ?? selectedIds)];
    setBusy(true);
    void runBatch(ids, action, errorMessage)
      .then((outcome) => {
        const message = batchMessage(outcome, verb, options.note);
        if (message.ok) toast.success(message.text);
        else toast.error(message.text);
        if (options.clearAfter === true) clearSelection();
      })
      .finally(() => setBusy(false));
  };

  return {
    count: selectedIds.length,
    busy,
    targets: userPlaylists(playlists),
    removableFrom,

    pin: (pinned) => run(pinned ? '已固定' : '已取消固定', (id) => setPinned(id, pinned)),

    // One request, not N: this endpoint takes the whole id list (B-7).
    addTo: (playlist) => {
      const ids = [...selectedIds];
      setBusy(true);
      void addSongs(playlist.id, ids)
        .then(
          () => toast.success(`已添加 ${ids.length} 首到「${playlist.name}」`),
          (err: unknown) => toast.error(errorMessage(err)),
        )
        .finally(() => setBusy(false));
    },

    removeFromCurrent: () => {
      if (removableFrom === null) return;
      run('已移除', (id) => removeSong(removableFrom, id), { clearAfter: true });
    },

    // The rows are read off the list on screen, which is where `has_file`
    // lives and where the `[需要下载]` marker comes from — so the button and
    // the marker can never disagree. A row the list no longer has (a refresh
    // landed between the click and here) is simply not in `songs`, and one
    // with no source is left to the daemon's 400, same as a redownload.
    download: () => {
      const selected = new Set(selectedIds);
      const missing = songs.filter((song) => selected.has(song.id) && song.has_file !== true);
      const skipped = selectedIds.length - missing.length;
      if (missing.length === 0) {
        toast.success('选中的歌都已经在本机了');
        return;
      }
      run('已开始下载', ensureFile, {
        ids: missing.map((song) => song.id),
        note: skipped === 0 ? undefined : `另有 ${skipped} 首已在本机`,
      });
    },

    redownload: () => run('已重新下载', redownload),
    redownloadLyrics: () => run('已重新下载歌词', redownloadLyrics),
    deleteLyrics: () => run('已删除歌词', deleteLyrics),

    deleteSelected: () => run('已删除', deleteSong, { clearAfter: true }),
  };
}
