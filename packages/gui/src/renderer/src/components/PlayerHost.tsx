// The media element and everything that has to be wired to it.
//
// The `key` is `daemonGeneration`, NOT the connection epoch (M4-8): an
// ordinary SSE reconnect must never interrupt playback, while a new daemon
// process means new media URLs and a token the old element cannot use. The
// remount destroys position and buffers, so the recovery state machine runs
// right after it.

import { useCallback, useEffect, useRef } from 'react';
import { invalidatePending } from '../player/pending.js';
import { useDataBus } from '../stores/data-bus.js';
import { usePlayer } from '../stores/player.js';
import { useSession } from '../stores/session.js';

/** Go parity: position is reported on a timer, not on every timeupdate. */
const REPORT_INTERVAL_MS = 2000;

export function PlayerHost(): React.JSX.Element {
  const generation = useSession((s) => s.daemonGeneration);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const mountedGeneration = useRef(generation);

  const attach = useCallback((audio: HTMLAudioElement | null) => {
    if (!audio) return;
    const player = usePlayer.getState();
    player.attachAudio(audio);

    const onTimeUpdate = (): void => usePlayer.getState().setTime(audio.currentTime);
    const onDuration = (): void => usePlayer.getState().setDuration(audio.duration);
    const onPlay = (): void => usePlayer.getState().setPlaying(true);
    const onPause = (): void => usePlayer.getState().setPlaying(false);
    const onEnded = (): void => usePlayer.getState().handleEnded();
    const onError = (): void => usePlayer.getState().handleMediaError();

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDuration);
    audio.addEventListener('loadedmetadata', onDuration);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDuration);
      audio.removeEventListener('loadedmetadata', onDuration);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      // Last chance to keep the position: the element is about to be gone.
      usePlayer.getState().detachAudio(audio.currentTime);
    };
  }, []);

  // A generation CHANGE means a new daemon; the first render is just a mount.
  useEffect(() => {
    if (generation === mountedGeneration.current) return;
    mountedGeneration.current = generation;
    // The pending intent's task id belonged to the daemon that went away
    // (M5-9): nothing will ever settle it.
    invalidatePending();
    void usePlayer.getState().recoverForGeneration(generation);
  }, [generation]);

  // Report on every state change the daemon mirrors. Subscribed rather than
  // rendered: this is a side effect of state moving, not of this component.
  useEffect(
    () =>
      usePlayer.subscribe((state, previous) => {
        if (
          state.currentSong !== previous.currentSong ||
          state.isPlaying !== previous.isPlaying ||
          state.playMode !== previous.playMode ||
          state.duration !== previous.duration
        ) {
          state.reportNow();
        }
      }),
    [],
  );

  // While playing, position alone changes — hence the timer (M4-10).
  useEffect(() => {
    if (!isPlaying) return;
    const timer = setInterval(() => usePlayer.getState().reportNow(), REPORT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isPlaying]);

  // Business events reach the player through the data bus: lyrics for the
  // song being played, and §4.4 reconciliation after any library change.
  useEffect(
    () =>
      useDataBus.subscribe((state, previous) => {
        const player = usePlayer.getState();
        if (state.lyricsRev !== previous.lyricsRev && player.currentSong) {
          if (state.lyricsSongId === null || state.lyricsSongId === player.currentSong.id) {
            player.refreshLyrics();
          }
        }
        if (state.songsRev !== previous.songsRev) void player.reconcileCurrentSong();
      }),
    [],
  );

  return (
    // biome-ignore lint/a11y/useMediaCaption: music playback, no caption track exists
    <audio key={generation} ref={attach} preload="metadata" className="hidden" />
  );
}
