// Playlists: the dropdown's list plus every write the library view can make.
//
// Writes emit `playlists:changed` on the daemon, so the data bus refreshes
// this store anyway; each action still refreshes directly, because a dropped
// SSE channel must not turn a successful write into a UI that shows nothing
// happened.

import type { PlaylistData } from '@lark/shared';
import { API_PATHS, VIRTUAL_ALL_PLAYLIST_ID, apiPath, request } from '@lark/shared';
import { create } from 'zustand';
import { createLane } from '../lib/lanes.js';
import { useLibrary } from './library.js';

const listLane = createLane();

interface PlaylistsState {
  playlists: readonly PlaylistData[];
  refresh: () => void;
  create: (name: string) => Promise<PlaylistData | null>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  addSongs: (playlistId: string, songIds: readonly string[]) => Promise<void>;
  removeSong: (playlistId: string, songId: string) => Promise<void>;
}

/** User playlists only — the virtual `all` is never an edit or add target. */
export function userPlaylists(playlists: readonly PlaylistData[]): readonly PlaylistData[] {
  return playlists.filter((p) => p.id !== VIRTUAL_ALL_PLAYLIST_ID);
}

export const usePlaylists = create<PlaylistsState>((set, get) => ({
  playlists: [],

  refresh: () => {
    void listLane
      .run((signal) => request<PlaylistData[]>('GET', API_PATHS.playlists, undefined, { signal }))
      .then((envelope) => {
        if (envelope === null) return;
        const playlists = envelope.data ?? [];
        set({ playlists });
        // §4.4: the playlist being viewed may have been deleted here, by the
        // CLI, or by another GUI session. Fall back to `all` rather than
        // leaving the view pointed at an id the daemon will 404 on.
        const { playlistId, setPlaylistId } = useLibrary.getState();
        if (playlistId !== VIRTUAL_ALL_PLAYLIST_ID && !playlists.some((p) => p.id === playlistId)) {
          setPlaylistId(VIRTUAL_ALL_PLAYLIST_ID);
        }
      })
      .catch(() => {
        // The connection indicator already says the daemon is unreachable;
        // the stale list stays usable until it comes back.
      });
  },

  create: async (name) => {
    const envelope = await request<PlaylistData>('POST', API_PATHS.playlists, { name });
    get().refresh();
    return envelope.data ?? null;
  },

  rename: async (id, name) => {
    await request<PlaylistData>('PUT', apiPath.playlist(id), { name });
    get().refresh();
  },

  remove: async (id) => {
    await request('DELETE', apiPath.playlist(id));
    if (useLibrary.getState().playlistId === id) {
      useLibrary.getState().setPlaylistId(VIRTUAL_ALL_PLAYLIST_ID);
    }
    get().refresh();
  },

  addSongs: async (playlistId, songIds) => {
    await request('POST', apiPath.playlistSongs(playlistId), { song_ids: songIds });
    get().refresh();
  },

  removeSong: async (playlistId, songId) => {
    await request('DELETE', apiPath.playlistSong(playlistId, songId));
    if (useLibrary.getState().playlistId === playlistId) useLibrary.getState().refresh();
    get().refresh();
  },
}));
