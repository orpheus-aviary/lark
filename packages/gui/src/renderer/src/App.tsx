import type { SongData } from '@lark/shared';
import { useCallback, useEffect } from 'react';
import { InteractionBar } from './components/InteractionBar.js';
import { SongList } from './components/SongList.js';
import { StatusBar } from './components/StatusBar.js';
import { TopBar } from './components/TopBar.js';
import { Toaster } from './components/ui/sonner.js';
import { EventsSubscriber } from './session/EventsSubscriber';
import { useConfig } from './stores/config.js';
import { useDataBus } from './stores/data-bus.js';
import { useLibrary } from './stores/library.js';
import { usePlaylists } from './stores/playlists.js';
import { applyFontSizes } from './theme/theme.js';

/**
 * The Go layout's seven segments, filled in milestone by milestone: T3 lands
 * TopBar / InteractionBar / SongList / StatusBar, T4 adds the player and
 * lyrics, T5 the download bar.
 */
export function App(): React.JSX.Element {
  const font = useConfig((s) => s.config?.font);
  const refreshConfig = useConfig((s) => s.refresh);
  const refreshSongs = useLibrary((s) => s.refresh);
  const refreshPlaylists = usePlaylists((s) => s.refresh);

  // Initial config fetch; later refreshes ride the hello epoch (M4-8).
  useEffect(() => {
    refreshConfig();
  }, [refreshConfig]);

  // Font sizes are DOM-level variables (body scope), not React state — the
  // one legitimate "sync with an external system" job (M4-12).
  useEffect(() => {
    if (font) applyFontSizes(font.global_font_size, font.lyrics_font_size);
  }, [font]);

  // The data bus is an external signal source, so it is subscribed to rather
  // than rendered: a bumped counter means "refetch what you have open".
  // `playlists:changed` feeds the song list too — removing a song from a
  // playlist changes the visible rows and emits nothing else.
  useEffect(() => {
    refreshSongs();
    refreshPlaylists();
    return useDataBus.subscribe((state, previous) => {
      const playlistsChanged = state.playlistsRev !== previous.playlistsRev;
      if (playlistsChanged) refreshPlaylists();
      if (playlistsChanged || state.songsRev !== previous.songsRev) refreshSongs();
    });
  }, [refreshSongs, refreshPlaylists]);

  // T4 replaces this seam with the player store; until then a row's play
  // gesture only moves the selection.
  const handlePlay = useCallback((song: SongData) => {
    useLibrary.getState().setSelectedSongId(song.id);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <EventsSubscriber />
      <TopBar />
      <InteractionBar />
      <SongList onPlay={handlePlay} currentSongId={null} />
      <StatusBar />
      <Toaster />
    </div>
  );
}
