// The main window driving the floating lyric window (⑤).
//
// PER LINE, NOT PER TICK. `currentTime` moves four times a second and the
// window draws lines, so publishing on the time would be forty messages for
// every one that changes anything. The effect depends on the INDEX instead,
// which is the same number the lyrics panel already computes — roughly one
// message every few seconds, plus one whenever the song, the playing state or
// the config moves.
//
// The config rides along because main holds no opinion of its own about this
// window (`shared/desktop-lyrics.ts`): the settings page changes it here, so
// here is where the truth about it is.

import { currentLrcIndex } from '@lark/shared';
import { useEffect } from 'react';
import { getPlatform } from '../platform/index.js';
import { useConfig } from '../stores/config.js';
import { usePlayer } from '../stores/player.js';

export function useDesktopLyricsPublisher(): void {
  const config = useConfig((s) => s.config?.desktop_lyrics ?? null);
  const song = usePlayer((s) => s.currentSong);
  const lyrics = usePlayer((s) => s.lyrics);
  const time = usePlayer((s) => s.currentTime);
  const playing = usePlayer((s) => s.isPlaying);

  const offset = song?.lyrics_offset ?? 0;
  const index = lyrics.length === 0 ? -1 : currentLrcIndex(lyrics, time, offset);

  useEffect(() => {
    // Before the config has loaded there is nothing to say — and saying it
    // with a default would open a window somebody switched off.
    if (config === null) return;
    getPlatform().publishDesktopLyrics({
      config,
      song: song === null ? null : { name: song.name, artist: song.artist },
      lyrics,
      index,
      playing,
    });
  }, [config, song, lyrics, index, playing]);
}
