// The song list on screen, and what it is a list OF.
//
// The view is one of two things, never a mix (D6/§4.1): a playlist's member
// list (`all` included — the daemon synthesises it), or a cross-library search
// result. Search is not a filter over the current playlist, which is why the
// "remove from this list" action disappears while searching.
//
// Staleness has two layers, because one is not enough (M4-7):
//  - each source has its own lane, so a later request in the SAME lane aborts
//    and out-ranks the earlier one;
//  - every response is stamped with the view it was issued for, so a response
//    from the lane we just LEFT (search → playlist, or the reverse) is dropped
//    even though its own lane never superseded it.

import type {
  DownloadTaskAcceptedData,
  PinSongRequest,
  RecognizeUrlData,
  SongData,
  UpdateSongRequest,
} from '@lark/shared';
import { API_PATHS, VIRTUAL_ALL_PLAYLIST_ID, apiPath, request } from '@lark/shared';
import { create } from 'zustand';
import { errorMessage } from '../lib/errors.js';
import { createLane } from '../lib/lanes.js';
import { planReorder } from '../lib/reorder.js';
import { pruneMissing, rangeBetween, toggleIn } from '../lib/selection.js';

const songsQueryLane = createLane();
const playlistMembersLane = createLane();

/** Identity of the visible list — what a response must still match to land. */
function viewKey(playlistId: string, search: string): string {
  return search === '' ? `list:${playlistId}` : `search:${search}`;
}

interface LibraryState {
  songs: readonly SongData[];
  loading: boolean;
  error: string | null;
  /** Playlist whose members are shown; `'all'` is the virtual list (R3). */
  playlistId: string;
  /** Committed search text (the input debounces before it gets here, D6). */
  search: string;
  /**
   * Selected rows, in the order they were picked (S1/B-1). Ordered rather
   * than a Set because "add these to a playlist" appends in that order.
   */
  selectedIds: readonly string[];
  /** Where a Shift range measures from: the last non-Shift pick (B-3). */
  selectionAnchor: string | null;
  setPlaylistId: (id: string) => void;
  setSearch: (search: string) => void;
  /** Replace the selection with this one row (a plain click, or "locate"). */
  selectOnly: (id: string) => void;
  /** Add or remove one row, keeping the rest (Cmd-click / the row checkbox). */
  toggleSelected: (id: string) => void;
  /** Extend from the anchor to this row, in the DISPLAYED order (Shift-click). */
  selectRange: (id: string, orderedIds: readonly string[]) => void;
  /** Select exactly the rows currently on screen (the header checkbox). */
  selectVisible: (orderedIds: readonly string[]) => void;
  clearSelection: () => void;
  refresh: () => void;
  /**
   * Show a playlist whose members the caller already loaded (§4.3): a remote
   * `play-playlist` / `switch-playlist` fetches them outside the refresh lanes
   * so it can refuse to switch when the load fails, and then commits the
   * result here rather than triggering a second fetch.
   */
  adoptPlaylistView: (playlistId: string, songs: readonly SongData[]) => void;
  // Song-scoped writes live with the list they change. The daemon emits
  // `songs:changed` for each of them, so the direct refresh below is the
  // belt to the data bus's braces (an SSE gap must not hide a committed edit).
  updateSong: (id: string, patch: UpdateSongRequest) => Promise<void>;
  deleteSong: (id: string) => Promise<void>;
  redownloadLyrics: (id: string) => Promise<void>;
  deleteLyrics: (id: string) => Promise<void>;
  /** Device-local pin (R18): an evicting cache never touches a pinned song. */
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  /** Force a fresh download of the audio, replacing whatever is on disk. */
  redownload: (id: string) => Promise<void>;
  /**
   * Fetch the audio only if it is MISSING (M5-8) — the zero-network case for
   * a song already here. What "download the selection" is built on: a
   * `redownload` over a selection would re-fetch every file that is fine.
   */
  ensureFile: (id: string) => Promise<void>;
  /** Preview what a URL resolves to. Writes NOTHING (R6). */
  recognizeUrl: (id: string, url: string) => Promise<RecognizeUrlData>;
  /**
   * Move a member to where another one sits, optimistically (T7). Only ever
   * valid for the manual order of a real playlist — the caller owns that gate
   * (R24). Rejects with the daemon's error after putting the old order back.
   */
  reorderSong: (movedId: string, targetId: string) => Promise<void>;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  songs: [],
  loading: false,
  error: null,
  playlistId: VIRTUAL_ALL_PLAYLIST_ID,
  search: '',
  selectedIds: [],
  selectionAnchor: null,

  // A view change makes the selection meaningless — those rows are not on
  // screen any more, and a Shift range would measure from a vanished anchor.
  setPlaylistId: (playlistId) => {
    if (get().playlistId === playlistId) return;
    set({ playlistId, selectedIds: [], selectionAnchor: null });
    get().refresh();
  },

  setSearch: (search) => {
    if (get().search === search) return;
    set({ search, selectedIds: [], selectionAnchor: null });
    get().refresh();
  },

  selectOnly: (id) => set({ selectedIds: [id], selectionAnchor: id }),

  toggleSelected: (id) =>
    set((state) => ({ selectedIds: toggleIn(state.selectedIds, id), selectionAnchor: id })),

  // The anchor deliberately does NOT move: shift-clicking again re-measures
  // from where the range started, which is what lets a user widen or narrow
  // the same range instead of ratcheting it open.
  selectRange: (id, orderedIds) =>
    set((state) => ({ selectedIds: rangeBetween(orderedIds, state.selectionAnchor, id) })),

  selectVisible: (orderedIds) => set({ selectedIds: [...orderedIds] }),

  clearSelection: () => set({ selectedIds: [], selectionAnchor: null }),

  refresh: () => {
    const { playlistId, search } = get();
    const searching = search !== '';
    const key = viewKey(playlistId, search);

    // Silence the source we are leaving: its in-flight response describes a
    // view that is no longer on screen, and its own lane will never supersede
    // it (nothing else is being asked of that lane).
    (searching ? playlistMembersLane : songsQueryLane).cancel();

    // Search deliberately sends no `limit`: the Go version's list stopped at
    // 50 rows through a parameter-name bug, and swapping that for a silent
    // 1000-row cut would be the same defect with a bigger number (D6).
    const path = searching
      ? `${API_PATHS.songs}?search=${encodeURIComponent(search)}`
      : apiPath.playlistSongs(playlistId);

    set({ loading: true });
    void (searching ? songsQueryLane : playlistMembersLane)
      .run((signal) => request<SongData[]>('GET', path, undefined, { signal }))
      .then((envelope) => {
        if (envelope === null) return; // superseded inside its lane
        if (viewKey(get().playlistId, get().search) !== key) return; // view moved on
        const songs = envelope.data ?? [];
        // A refresh may have deleted rows the user had selected (B-11); the
        // rest of the selection survives — this is not a view change.
        const present = new Set(songs.map((song) => song.id));
        set((state) => ({
          songs,
          loading: false,
          error: null,
          selectedIds: pruneMissing(state.selectedIds, present),
        }));
      })
      .catch((err: unknown) => {
        if (viewKey(get().playlistId, get().search) !== key) return;
        set({ loading: false, error: errorMessage(err) });
      });
  },

  adoptPlaylistView: (playlistId, songs) => {
    // Whatever either lane has in flight describes the view being left.
    songsQueryLane.cancel();
    playlistMembersLane.cancel();
    set({
      playlistId,
      songs,
      search: '',
      loading: false,
      error: null,
      selectedIds: [],
      selectionAnchor: null,
    });
  },

  updateSong: async (id, patch) => {
    await request<SongData>('PUT', apiPath.song(id), patch);
    get().refresh();
  },

  deleteSong: async (id) => {
    await request('DELETE', apiPath.song(id));
    set((state) => ({
      selectedIds: state.selectedIds.filter((selected) => selected !== id),
      selectionAnchor: state.selectionAnchor === id ? null : state.selectionAnchor,
    }));
    get().refresh();
  },

  /** Enqueues a lyrics task; the result arrives as `lyrics:changed` (M3-9). */
  redownloadLyrics: async (id) => {
    await request<DownloadTaskAcceptedData>('POST', apiPath.downloadLyrics(id));
  },

  deleteLyrics: async (id) => {
    await request('DELETE', apiPath.lyrics(id));
  },

  setPinned: async (id, pinned) => {
    await request<SongData>('PUT', apiPath.songPin(id), { pinned } satisfies PinSongRequest);
    get().refresh();
  },

  redownload: async (id) => {
    await request<DownloadTaskAcceptedData>('POST', apiPath.songRedownload(id));
  },

  ensureFile: async (id) => {
    await request<DownloadTaskAcceptedData>('POST', apiPath.songEnsureFile(id));
  },

  recognizeUrl: async (id, url) => {
    const envelope = await request<RecognizeUrlData>('POST', apiPath.songRecognizeUrl(id), { url });
    return envelope.data as RecognizeUrlData;
  },

  reorderSong: async (movedId, targetId) => {
    const { playlistId, search, songs } = get();
    const plan = planReorder(songs, movedId, targetId);
    if (plan === null) return;

    // Optimistic: the row is already under the user's finger where they put
    // it, and snapping back for the duration of a round trip reads as a bug.
    set({ songs: plan.next });
    try {
      await request('POST', apiPath.playlistReorder(playlistId), plan.anchors);
    } catch (err) {
      // Restore only if the view has not moved on — otherwise `songs` now
      // describes a different list and putting the old order back would show
      // the wrong playlist's rows until the refresh lands.
      if (get().playlistId === playlistId && get().search === search) {
        set({ songs });
        get().refresh();
      }
      throw err;
    }
  },
}));
