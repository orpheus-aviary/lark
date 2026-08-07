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
  /** Deletes without asking — the caller owns the confirmation (B-8). */
  deleteSelected: () => void;
}

export function useBatchActions(): BatchActions {
  const selectedIds = useLibrary((s) => s.selectedIds);
  const clearSelection = useLibrary((s) => s.clearSelection);
  const setPinned = useLibrary((s) => s.setPinned);
  const deleteSong = useLibrary((s) => s.deleteSong);
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
    options: { clearAfter?: boolean } = {},
  ): void => {
    // The ids are captured now: the list may refresh mid-batch.
    const ids = [...selectedIds];
    setBusy(true);
    void runBatch(ids, action, errorMessage)
      .then((outcome) => {
        const message = batchMessage(outcome, verb);
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

    deleteSelected: () => run('已删除', deleteSong, { clearAfter: true }),
  };
}
