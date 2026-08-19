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

import type { LibraryService, ListSongsResult } from '@lark/core/portable';
import type { PlaylistData, SongData } from '@lark/shared';
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { BootResult } from '../boot/sequence';

/** The library as it is RIGHT NOW. A new one exists after every write. */
export interface LibraryView {
  songs(options?: { search?: string; limit?: number }): ListSongsResult;
  playlists(): PlaylistData[];
  playlistSongs(id: string): SongData[];
}

interface LibraryValue {
  library: LibraryService;
  view: LibraryView;
  boot: BootResult;
  /** Say this after a write; it is what replaces `view`. */
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
      playlists: () => library.listPlaylists(),
      playlistSongs: (id) => library.listPlaylistSongs(id),
    }),
    [library],
  );
  const [view, setView] = useState<LibraryView>(() => reader());
  const changed = useCallback(() => setView(reader()), [reader]);

  const value = useMemo(() => ({ library, view, boot, changed }), [library, view, boot, changed]);
  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryValue {
  const value = useContext(LibraryContext);
  if (value === null) throw new Error('useLibrary outside a LibraryProvider');
  return value;
}
