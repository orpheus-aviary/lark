// The first screen (N2a, criterion 1) plus N2b's data-layer panel.
//
// Two of the three header lines are read out of the packages this app is
// allowed to link, and the panel below drives the real open factory. That is
// the point: `just mobile-bundle-smoke` asserts the portable barrel is IN the
// built module graph, and a screen that imported nothing would let that
// assertion pass while proving nothing (N1i — an isolated file is not in the
// graph and stays green no matter what you put in it).
//
// NOTHING RUNS ON MOUNT. The subplan's §3 forbids N2b from wiring a persistent
// startup path: there is no D16 gate yet, and a build that opens a library at
// launch is a build that will happily adopt a restored one. The panel is a
// button, and it works on a scratch file it makes and deletes itself.
//
// The four tabs, the library, and the identity gate arrive in N2c–N2f.

import { LATEST_KNOWN_VERSION } from '@lark/core/portable';
import { LOCAL_API_VERSION } from '@lark/shared/api-paths';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { installPortableRuntime } from './boot/runtime';
import { type CheckRow, runDataLayerSelfCheck } from './db/self-check';

export function App() {
  const [rows, setRows] = useState<CheckRow[] | null>(null);

  const run = () => {
    // §2.2 step ①. Without it the first minted uuid throws, and on this path
    // that is `ensureDeviceUuid` — after a library has already been created.
    installPortableRuntime();
    setRows(runDataLayerSelfCheck());
  };

  const failed = rows?.filter((row) => !row.ok).length ?? 0;

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>lark</Text>
        <Text style={styles.line}>schema v{LATEST_KNOWN_VERSION}</Text>
        <Text style={styles.line}>protocol v{LOCAL_API_VERSION}</Text>

        <Pressable style={styles.button} onPress={run} accessibilityRole="button">
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

        <Text style={styles.note}>N2b：数据层原语。曲库、身份门与四 tab 还没到。</Text>
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
