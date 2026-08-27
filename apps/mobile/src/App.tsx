// The app's shell (N2a first screen, N2c the real boot, N2f the library).
//
// N2c is where the app was finally allowed to open its own library at launch,
// and the reason is the whole point of that batch: until D16 existed, a
// persistent startup path was a build that would adopt a restored library as
// its own (§3). It goes through `runBootSequence` and nothing else — that
// function is the only thing entitled to open `songs.db`.
//
// This file now does three things and stops: boot, assemble what the screens
// are given — the download engine, then the library service that has to share
// its claim registry — and render the tabs. It draws NOTHING of its own since
// 0.1.1 ②: the 「lark」 wordmark it used to put across the top cost every tab
// 60dp to say what the launcher icon and the task switcher already said.

import {
  type LibraryService,
  NotFoundError,
  type QueueSource,
  readLastPlayback,
  readNowPlayingMode,
  readPlayMode,
  touchLastAccessed,
  writeLastPlayback,
  writeNowPlayingMode,
  writePlayMode,
} from '@lark/core/portable';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StatusBar as RNStatusBar, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { type BootResult, bootOnce } from './boot/sequence';
import { downloadRuntimeOnce } from './downloads/engine';
import { bindEnsure } from './downloads/ensure-runtime';
import { downloadHistoryOnce } from './downloads/history-runtime';
import { engineLogger } from './downloads/log';
import { bindPlayer } from './player';
import { queueFrom, resolveQueue } from './player/queue';
import { createLibrary } from './services/library';
import { useShareIntentBridge } from './share/intent';
import { createAppStateSource } from './sync/app-state';
import { syncContextOnce } from './sync/context';
import { syncTriggersOnce } from './sync/triggers';
import { LibraryProvider } from './ui/library-context';
import { Shell } from './ui/shell';
import { C, S } from './ui/theme';

type BootState =
  | { status: 'booting' }
  | { status: 'ready'; result: BootResult; library: LibraryService }
  | { status: 'refused'; name: string; message: string };

export function App() {
  const [boot, setBoot] = useState<BootState>({ status: 'booting' });
  // ABOVE the boot state on purpose (N4d-3, decision p). A share that launches
  // the app cold arrives within milliseconds of the bundle running — long
  // before the library is open — and the only thing that could read it lives
  // three levels down behind a conditional. This collects it; `share/intent.ts`
  // holds it until something asks.
  useShareIntentBridge();

  useEffect(() => {
    let cancelled = false;
    // The one external system this component synchronises with, and the one
    // `useEffect` in the app: the library on disk. `bootOnce` and not
    // `runBootSequence` — an Activity that was destroyed and rebuilt remounts
    // this, and booting a library this process already owns is both wrong and,
    // on expo-sqlite 57.0.1, fatal (see there).
    bootOnce()
      .then((result) => {
        if (cancelled) return;
        // Before the library, because the library has to be given the journal
        // runtime that shares the engine's claims rather than the boot one
        // (`downloads/engine.ts`).
        const runtime = downloadRuntimeOnce(result);
        // 🔴 HERE AND NOT IN THE SCREEN THAT SHOWS IT (0.1.1 ⑦). The history
        // subscribes to the hub when it is first built, and a download can
        // finish without anybody having opened 添加 — tapping a song with no
        // file starts one from 歌曲, and an ensure-file that failed on the bus
        // is exactly the thing a record is for. Built lazily, that failure
        // would go unrecorded because nothing was listening.
        downloadHistoryOnce(result);
        const library = createLibrary(result, runtime.fileOps);
        // Sync, assembled but not started (N5c): no session, no timers, no
        // socket — the triggers are N5d. It takes the SAME journal runtime the
        // library just did, for the same reason: a remote delete unlinks audio
        // a download may be replacing, and only one claim registry can make
        // those take turns.
        const syncCtx = syncContextOnce({
          db: result.db,
          files: result.files,
          fileOps: runtime.fileOps,
        });
        // …and now started (N5d). The triggers restore the session from
        // SecureStore, then follow the foreground: armed while somebody is
        // looking, silent while the app is in a pocket. Sync deliberately does
        // NOT run in the background — JS timers are frozen there, and a socket
        // under a dark screen is a battery bug (decision b, deferred).
        syncTriggersOnce(syncCtx, createAppStateSource(), { logger: engineLogger });
        // Tapping a song with no file is a play that starts a minute from now
        // (N4g). It needs all three of these — the engine to fetch, the
        // library to re-read the row, the player to decide whether the tap is
        // still the newest one — so it is bound here, where all three exist.
        const ensure = bindEnsure({ library, runtime });
        // The player is built at import time (one process, one player) but
        // half its dependencies need the library that just opened. This is
        // where they arrive, next to the service they belong to.
        const songsOf = (source: QueueSource) =>
          source.kind === 'all'
            ? library.listSongs({}).songs
            : library.listPlaylistSongs(source.id);
        bindPlayer({
          resolveQueue: (queue) => resolveQueue(queue, songsOf(queue.source)),
          readLyrics: (songId) => library.readLyrics(songId),
          readMode: () => readPlayMode(result.deviceSettings),
          // Both persists are device settings since N7a, so both are file
          // writes now. Fire-and-forget, with the failure logged rather than
          // dropped: a mode toggle has no form to report back to, and an
          // unhandled rejection in a player callback takes the app with it.
          persistMode: (mode) => {
            void writePlayMode(result.deviceSettings, mode).catch((err: unknown) => {
              engineLogger.warn({ err: String(err) }, 'could not save the play mode');
            });
          },
          readNowPlayingMode: () => readNowPlayingMode(result.deviceSettings),
          persistNowPlayingMode: (mode) => {
            void writeNowPlayingMode(result.deviceSettings, mode).catch((err: unknown) => {
              engineLogger.warn({ err: String(err) }, 'could not save the now-playing mode');
            });
          },
          // The library decides whether a remembered position is still true —
          // `has_file` is a disk probe, so the check is handed in rather than
          // guessed at. A `null` here is every stale case at once, and the
          // player simply starts with nothing.
          restore: () => {
            const memory = readLastPlayback(result.db.sqlite, {
              hasFile: (songId) => library.getSong(songId).has_file === true,
            });
            if (memory === null) return null;
            const songs = songsOf(memory.queue);
            const song = songs.find((candidate) => candidate.id === memory.songId);
            // Present in the library but not in its own queue: the queue is
            // rebuilt from a source, and a song can have left it since.
            if (song === undefined) return null;
            return {
              song,
              queue: queueFrom(memory.queue, songs),
              positionSeconds: memory.positionSeconds,
            };
          },
          rememberPlayback: (value) => writeLastPlayback(result.db.sqlite, value),
          // The LRU key eviction sorts by (decision g). A song deleted between
          // the tap and the source starting is the one thing this can hit, and
          // it is not worth an error: what it was about to record is that a
          // song that no longer exists was played.
          touch: (songId) => {
            try {
              touchLastAccessed(result.db.drizzle, result.db.sqlite, songId);
            } catch (err) {
              if (!(err instanceof NotFoundError)) throw err;
            }
          },
          // 下一首 landed on a song with no file (N4g-3). `fixedQueue`: the
          // player is already playing out of this queue, and a list that
          // happens to be on screen a minute later has no business replacing
          // it — that rule is for a tap on a row.
          fetchAndPlay: (song, queue) => ensure.request(song, queue, { fixedQueue: true }),
        });
        setBoot({ status: 'ready', result, library });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A refusal is a screen, not a crash. §2.4's refusals mean somebody's
        // library is sitting there untouched, and the worst thing to do with
        // it is retry in a loop.
        setBoot({
          status: 'refused',
          name: err instanceof Error ? err.name : 'Error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />

      {boot.status === 'booting' && <Text style={styles.note}>正在打开曲库…</Text>}

      {boot.status === 'refused' && (
        <View style={styles.refusal}>
          <Text style={styles.refusalName}>打不开这个曲库：{boot.name}</Text>
          <Text style={styles.note}>{boot.message}</Text>
        </View>
      )}

      {boot.status === 'ready' && (
        <LibraryProvider library={boot.library} boot={boot.result}>
          <Shell />
        </LibraryProvider>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // 🔴 THIS IS THE NOTCH INSET, and it is what survived 0.1.1 ② — the app's
  // own 「lark」 wordmark went, this did not. `SafeAreaView` is a no-op on
  // Android (it insets for iOS notches only), so without this line the first
  // row of every tab draws over the clock. MEASURED, on the frozen device.
  //
  // Plus one gap, because the wordmark used to be the thing holding the
  // content off the status bar and now nothing is.
  screen: {
    flex: 1,
    backgroundColor: C.bg,
    paddingTop: (RNStatusBar.currentHeight ?? 0) + S.gap,
  },
  note: { color: C.faint, fontSize: 13, paddingHorizontal: S.pad, lineHeight: 20 },
  refusal: { gap: S.gap },
  refusalName: { color: C.danger, fontSize: 15, paddingHorizontal: S.pad },
});
