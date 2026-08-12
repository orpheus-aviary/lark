import { useEffect } from 'react';
import { Controls } from './components/Controls.js';
import { InteractionBar } from './components/InteractionBar.js';
import { LyricsPanel } from './components/LyricsPanel.js';
import { PlayerHost } from './components/PlayerHost.js';
import { ProgressBar } from './components/ProgressBar.js';
import { SongList } from './components/SongList.js';
import { StatusBar } from './components/StatusBar.js';
import { TopBar } from './components/TopBar.js';
import { Toaster } from './components/ui/sonner.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { EventsSubscriber } from './session/EventsSubscriber';
import { useConfig } from './stores/config.js';
import { useDataBus } from './stores/data-bus.js';
import { useLibrary } from './stores/library.js';
import { usePlayer } from './stores/player.js';
import { usePlaylists } from './stores/playlists.js';
import { useSync } from './stores/sync.js';
import { applyFontSizes, watchTheme } from './theme/theme.js';

/**
 * The Go layout's seven segments: TopBar / InteractionBar / SongList /
 * ProgressBar / Controls / LyricsPanel / StatusBar. T5 fills the download
 * half of the interaction bar.
 */
export function App(): React.JSX.Element {
  const font = useConfig((s) => s.config?.font);
  const themeMode = useConfig((s) => s.config?.theme.mode ?? 'system');
  const refreshConfig = useConfig((s) => s.refresh);
  const refreshSync = useSync((s) => s.refresh);
  const refreshConflicts = useSync((s) => s.refreshConflicts);
  const refreshSongs = useLibrary((s) => s.refresh);
  const refreshPlaylists = usePlaylists((s) => s.refresh);
  const play = usePlayer((s) => s.play);
  const currentSongId = usePlayer((s) => s.currentSong?.id ?? null);

  useKeyboardShortcuts();

  // Initial config and sync fetches; later refreshes ride the hello epoch
  // (M4-8) and, for sync, its own `sync:status_changed` frames.
  useEffect(() => {
    refreshConfig();
    refreshSync();
    refreshConflicts();
  }, [refreshConfig, refreshSync, refreshConflicts]);

  // Font sizes are DOM-level variables (body scope), not React state — the
  // one legitimate "sync with an external system" job (M4-12).
  useEffect(() => {
    if (font) applyFontSizes(font.global_font_size, font.lyrics_font_size);
  }, [font]);

  // Same job for the theme: re-running on a mode change is what tears down the
  // matchMedia listener when the user leaves 'system' (M5-2).
  useEffect(() => watchTheme(themeMode), [themeMode]);

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

  return (
    <div className="flex h-full flex-col">
      <EventsSubscriber />
      <PlayerHost />
      <TopBar />
      <InteractionBar />
      <SongList onPlay={(song) => void play(song)} currentSongId={currentSongId} />
      <ProgressBar />
      <Controls />
      <LyricsPanel />
      <StatusBar />
      <Toaster />
    </div>
  );
}
