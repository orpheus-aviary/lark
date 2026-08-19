// The app's shell (N2a first screen, N2b data panel, N2c the real boot, N2f
// the library itself).
//
// N2c is where the app was finally allowed to open its own library at launch,
// and the reason is the whole point of that batch: until D16 existed, a
// persistent startup path was a build that would adopt a restored library as
// its own (§3). It goes through `runBootSequence` and nothing else — that
// function is the only thing entitled to open `songs.db`.
//
// This file now does three things and stops: boot, hand the result to the
// library service, render the tabs. The boot's verdict moved into 设置, where
// it is still readable off the device (a release build has no logcat, N0b-3)
// without being the first thing a person sees.

import type { LibraryService } from '@lark/core/portable';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StatusBar as RNStatusBar, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { type BootResult, bootOnce } from './boot/sequence';
import { createLibrary } from './services/library';
import { LibraryProvider } from './ui/library-context';
import { Shell } from './ui/shell';
import { C, S } from './ui/theme';

type BootState =
  | { status: 'booting' }
  | { status: 'ready'; result: BootResult; library: LibraryService }
  | { status: 'refused'; name: string; message: string };

export function App() {
  const [boot, setBoot] = useState<BootState>({ status: 'booting' });

  useEffect(() => {
    let cancelled = false;
    // The one external system this component synchronises with, and the one
    // `useEffect` in the app: the library on disk. `bootOnce` and not
    // `runBootSequence` — an Activity that was destroyed and rebuilt remounts
    // this, and booting a library this process already owns is both wrong and,
    // on expo-sqlite 57.0.1, fatal (see there).
    bootOnce()
      .then((result) => {
        if (!cancelled) setBoot({ status: 'ready', result, library: createLibrary(result) });
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
      <Text style={styles.title}>lark</Text>

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
  // `SafeAreaView` is a no-op on Android — it insets for iOS notches only —
  // so the title drew over the clock until this was here. MEASURED, on the
  // frozen device.
  screen: { flex: 1, backgroundColor: C.bg, paddingTop: RNStatusBar.currentHeight ?? 0 },
  title: {
    color: C.text,
    fontSize: 24,
    fontWeight: '600',
    paddingHorizontal: S.pad,
    paddingTop: S.gap,
    paddingBottom: S.pad,
  },
  note: { color: C.faint, fontSize: 13, paddingHorizontal: S.pad, lineHeight: 20 },
  refusal: { gap: S.gap },
  refusalName: { color: C.danger, fontSize: 15, paddingHorizontal: S.pad },
});
