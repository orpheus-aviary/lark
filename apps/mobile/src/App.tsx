// The app's shell (N2a first screen, N2b data panel, N2c the real boot).
//
// N2c is where the app is finally allowed to open its own library at launch,
// and the reason is the whole point of the batch: until D16 existed, a
// persistent startup path was a build that would adopt a restored library as
// its own (§3). It goes through `runBootSequence` and nothing else — that
// function is the only thing entitled to open `songs.db`.
//
// The boot's verdict is on screen rather than in a log because a release build
// has no logcat to print to (N0b-3), and criteria 17/18/19 are judged by
// reading it back off the device.
//
// The four tabs and the library itself arrive in N2f.

import { LATEST_KNOWN_VERSION } from '@lark/core/portable';
import { LOCAL_API_VERSION } from '@lark/shared/api-paths';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { type BootResult, runBootSequence } from './boot/sequence';
import { type CheckRow, runDataLayerSelfCheck } from './db/self-check';

type BootState =
  | { status: 'booting' }
  | { status: 'ready'; result: BootResult }
  | { status: 'refused'; name: string; message: string };

export function App() {
  const [boot, setBoot] = useState<BootState>({ status: 'booting' });
  const [rows, setRows] = useState<CheckRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The one external system this component synchronises with, and the one
    // `useEffect` in the app: the library on disk.
    runBootSequence()
      .then((result) => {
        if (!cancelled) setBoot({ status: 'ready', result });
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

  const failed = rows?.filter((row) => !row.ok).length ?? 0;

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>lark</Text>
        <Text style={styles.line}>schema v{LATEST_KNOWN_VERSION}</Text>
        <Text style={styles.line}>protocol v{LOCAL_API_VERSION}</Text>

        {boot.status === 'booting' && <Text style={styles.line}>boot: …</Text>}

        {boot.status === 'refused' && (
          <View style={styles.row}>
            <Text style={[styles.rowName, styles.fail]}>boot refused: {boot.name}</Text>
            <Text style={styles.rowDetail}>{boot.message}</Text>
          </View>
        )}

        {boot.status === 'ready' && (
          <View style={styles.row}>
            <Text style={[styles.rowName, styles.pass]}>boot: {boot.result.decision.action}</Text>
            <Text style={styles.rowDetail}>{boot.result.decision.reason}</Text>
            <Text style={styles.rowDetail}>install_id {boot.result.installId}</Text>
            <Text style={styles.rowDetail}>device_uuid {boot.result.deviceUuid}</Text>
            {boot.result.converged !== null && (
              <Text style={styles.rowDetail}>
                converged: {boot.result.converged.changes} changes ·{' '}
                {boot.result.converged.tombstones} tombstones · {boot.result.converged.cursors}{' '}
                cursors · {boot.result.converged.bindings} bindings · kept{' '}
                {boot.result.converged.fileOpsKept} file ops
              </Text>
            )}
          </View>
        )}

        <Pressable
          style={styles.button}
          onPress={() => setRows(runDataLayerSelfCheck())}
          accessibilityRole="button"
        >
          <Text style={styles.buttonLabel}>Run data layer check</Text>
        </Pressable>

        {rows !== null && (
          <Text style={[styles.verdict, failed === 0 ? styles.pass : styles.fail]}>
            {rows.length - failed}/{rows.length} passed
          </Text>
        )}

        {rows?.map((row) => (
          <View key={row.name} style={styles.row}>
            <Text style={[styles.rowName, row.ok ? styles.pass : styles.fail]}>
              {row.ok ? '✓' : '✗'} {row.name}
            </Text>
            <Text style={styles.rowDetail}>{row.detail}</Text>
          </View>
        ))}

        <Text style={styles.note}>N2c：身份门。曲库与四 tab 还没到。</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#09090b' },
  body: { padding: 24, gap: 6 },
  title: { color: '#fafafa', fontSize: 32, fontWeight: '600' },
  line: { color: '#a1a1aa', fontSize: 15, fontVariant: ['tabular-nums'] },
  button: {
    marginTop: 20,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#27272a',
    alignSelf: 'flex-start',
  },
  buttonLabel: { color: '#fafafa', fontSize: 15 },
  verdict: { marginTop: 16, fontSize: 15, fontWeight: '600' },
  row: { marginTop: 10 },
  rowName: { fontSize: 14 },
  rowDetail: { color: '#71717a', fontSize: 12, marginTop: 2 },
  pass: { color: '#22c55e' },
  fail: { color: '#ef4444' },
  note: { color: '#52525b', fontSize: 13, marginTop: 24 },
});
