// Data-bus: monotonic revision counters (owl's pattern, M4-7). SSE events are
// refresh SIGNALS — a consumer watches its counter and refetches what it has
// open; payloads never carry the data itself.

import { create } from 'zustand';

interface DataBusState {
  songsRev: number;
  playlistsRev: number;
  lyricsRev: number;
  /** Song the last lyrics bump was about; `null` = all songs (hello refresh). */
  lyricsSongId: string | null;
  bumpSongs: () => void;
  bumpPlaylists: () => void;
  bumpLyrics: (songId: string | null) => void;
  /** `hello` full refresh (M4-8): every lane refetches. */
  bumpAll: () => void;
}

export const useDataBus = create<DataBusState>((set) => ({
  songsRev: 0,
  playlistsRev: 0,
  lyricsRev: 0,
  lyricsSongId: null,
  bumpSongs: () => set((s) => ({ songsRev: s.songsRev + 1 })),
  bumpPlaylists: () => set((s) => ({ playlistsRev: s.playlistsRev + 1 })),
  bumpLyrics: (songId) => set((s) => ({ lyricsRev: s.lyricsRev + 1, lyricsSongId: songId })),
  bumpAll: () =>
    set((s) => ({
      songsRev: s.songsRev + 1,
      playlistsRev: s.playlistsRev + 1,
      lyricsRev: s.lyricsRev + 1,
      lyricsSongId: null,
    })),
}));
