// The booted library, as one thing the screens share (N2f).
//
// NOT a store library. The desktop keeps its view state in zustand because a
// player and an SSE stream push into it from outside React; this batch has
// neither — every read is a synchronous call on `LibraryService` — so a
// context is the whole mechanism. When N3's player needs to change state from
// outside the tree, that is the moment to ask for more than this, with a
// reason.
//
// READS GO THROUGH `view`, WRITES THROUGH `library`, and the split is not
// decoration. A screen derives its list with `useMemo`; the thing that has to
// invalidate it is "somebody wrote", which as a bare counter is a dependency
// the linter cannot check and a reader cannot see used. So a write replaces
// `view` with a new object instead: the dependency is the reader itself,
// listing it is honest, and `useExhaustiveDependencies` agrees.
//
// WHAT REPLACES IT IS THE SIGNAL, NOT THE BUTTON (N4g-2, decision h). `changed()`
// used to do both jobs — swap the view AND announce — which meant only writes
// with a finger on them refreshed the screen. Everything N4g added writes with
// nobody's finger on anything: an ensure-file finishing, a drain deleting an
// audio file. Both already emit `libraryChanged` (the engine's callbacks, the
// eviction runtime), and neither could reach this. So this subscribes like
// every other reader, `changed()` is now just the announcement, and there is
// one path from "something wrote" to "the list says so".

import type {
  CacheOptions,
  CacheStatus,
  LibraryService,
  ListSongsResult,
} from '@lark/core/portable';
import type { PlaylistData, SongData } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { BootResult } from '../boot/sequence';
import { libraryChanged, onLibraryChanged } from '../library-signal';

/** The library as it is RIGHT NOW. A new one exists after every write. */
export interface LibraryView {
  songs(options?: { search?: string; limit?: number }): ListSongsResult;
  playlists(): PlaylistData[];
  playlistSongs(id: string): SongData[];
  /**
   * How much room the audio takes (N4g-2). A read like the other three, and
   * here for the same reason: a download, a delete and an eviction all change
   * the answer, and all three announce themselves.
   */
  cacheStatus(options: CacheOptions): CacheStatus;
}

interface LibraryValue {
  library: LibraryService;
  view: LibraryView;
  boot: BootResult;
  /** Say this after a write. It announces; the announcement replaces `view`. */
  changed: () => void;
}

const LibraryContext = createContext<LibraryValue | null>(null);

export function LibraryProvider({
  library,
  boot,
  children,
}: {
  library: LibraryService;
  boot: BootResult;
  children: ReactNode;
}) {
  // The reader IS the state. A revision counter would work too, and it was
  // the first shape this took — but a counter is a dependency nothing in the
  // body uses, so neither a reader nor the linter can confirm it invalidates
  // what it claims to. `library` is created once at boot and never replaced,
  // so nothing else can go stale here.
  const reader = useCallback(
    (): LibraryView => ({
      songs: (options = {}) => library.listSongs(options),
      // WITHOUT THE VIRTUAL `all` (2026-08-24). `listPlaylists()` puts it
      // first by contract — the service composes it so that a name-based
      // reference resolves the same with or without a daemon (M6) — and NO
      // screen on this phone wants it: the 歌曲 tab already IS every song, and
      // the add page's 「存到」 would otherwise offer a playlist called `all`
      // beside 「仅曲库」, which is the same choice said twice and the broken
      // half of it. Picking it made a single download report a soft playlist
      // failure and a pasted batch fail admission outright
      // (`#assertPlaylistExists`).
      //
      // Filtered HERE rather than in each screen, because it was already
      // filtered in one of them and forgotten in the other.
      playlists: () =>
        library.listPlaylists().filter((playlist) => playlist.id !== VIRTUAL_ALL_PLAYLIST_ID),
      playlistSongs: (id) => library.listPlaylistSongs(id),
      cacheStatus: (options) => library.cacheStatus(options),
    }),
    [library],
  );
  const [view, setView] = useState<LibraryView>(() => reader());
  // The one external system this component synchronises with: the library, as
  // everything that writes to it announces itself. `reader` changes only when
  // the service does (never, after boot), so this subscribes once.
  useEffect(() => onLibraryChanged(() => setView(reader())), [reader]);
  // Say it happened. The player hears it too — its queue is a list of ids, and
  // a song deleted here has to leave it (§2.8) — and when sync starts deleting
  // rows in N5 it emits the same signal and everything keeps working without
  // knowing about sync.
  const changed = useCallback(() => libraryChanged(), []);

  const value = useMemo(() => ({ library, view, boot, changed }), [library, view, boot, changed]);
  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryValue {
  const value = useContext(LibraryContext);
  if (value === null) throw new Error('useLibrary outside a LibraryProvider');
  return value;
}
