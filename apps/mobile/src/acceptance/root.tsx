// The acceptance build's root (decision o①).
//
// Reached only when Metro was told `LARK_ACCEPTANCE=1`; the production bundle
// does not contain this file, and `scripts/check-portable-bundles.mjs` asserts
// that against the graph Metro actually built.
//
// It does NOT boot on mount, and that is the whole difference from the
// product's root: every scenario here owns the library's state from a known
// starting point, and a boot that had already happened would be a starting
// point nobody chose.

import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { type ScenarioRow, runD16Scenarios } from './d16';
import { runFileSystemScenarios } from './fs';

export function Root() {
  const [rows, setRows] = useState<ScenarioRow[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = (suite: () => Promise<ScenarioRow[]>) => () => {
    setRunning(true);
    setRows(null);
    suite()
      .then(setRows)
      .catch((err: unknown) => {
        setRows([
          {
            name: 'the harness itself',
            ok: false,
            detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          },
        ]);
      })
      .finally(() => setRunning(false));
  };

  const failed = rows?.filter((row) => !row.ok).length ?? 0;

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>lark · acceptance</Text>
        <Text style={styles.line}>D16 — criteria 17, 18, 19 · files — 9, 10②③</Text>

        <Pressable style={styles.button} onPress={run(runD16Scenarios)} accessibilityRole="button">
          <Text style={styles.buttonLabel}>{running ? 'Running…' : 'Run D16 scenarios'}</Text>
        </Pressable>

        <Pressable
          style={styles.button}
          onPress={run(runFileSystemScenarios)}
          accessibilityRole="button"
        >
          <Text style={styles.buttonLabel}>
            {running ? 'Running…' : 'Run file system scenarios'}
          </Text>
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
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#09090b' },
  body: { padding: 24, gap: 6 },
  title: { color: '#fafafa', fontSize: 26, fontWeight: '600' },
  line: { color: '#a1a1aa', fontSize: 14 },
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
});
