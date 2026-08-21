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
import { runAudioLandingScenarios } from './audio-landing';
import { type ScenarioRow, runD16Scenarios } from './d16';
import { armMidDrainKill, resumeAfterKill, runFileOpScenarios } from './file-ops';
import { runFixtureImportScenarios } from './fixture-import';
import { runFileSystemScenarios } from './fs';
import { runLibraryContractScenarios } from './library-contract';
import { runPlaybackScenarios } from './playback';
import { runSortScenarios } from './sort';
import { runSweepScenarios } from './sweep';

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
        <Text style={styles.line}>
          D16 — 17, 18, 19 · files — 9, 10②③ · journal — 12 · library — 13 · playback — 4, 3③ ·
          sweep — 11, 12, 13 · landing — 7, 8, 10
        </Text>

        <Pressable style={styles.button} onPress={run(runD16Scenarios)} accessibilityRole="button">
          <Text style={styles.buttonLabel}>{running ? 'Running…' : 'Run D16 scenarios'}</Text>
        </Pressable>

        <Pressable
          style={styles.button}
          onPress={run(runLibraryContractScenarios)}
          accessibilityRole="button"
        >
          <Text style={styles.buttonLabel}>{running ? 'Running…' : 'Run library contract'}</Text>
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

        <Pressable
          style={styles.button}
          onPress={run(runFileOpScenarios)}
          accessibilityRole="button"
        >
          <Text style={styles.buttonLabel}>{running ? 'Running…' : 'Run file op scenarios'}</Text>
        </Pressable>

        {/*
          The one fixture that has to be pushed rather than synthesised: a
          library the DESKTOP wrote. `just mobile-push-fixture` puts it where
          this can reach it.
        */}
        <Pressable
          style={styles.button}
          onPress={run(runFixtureImportScenarios)}
          accessibilityRole="button"
        >
          <Text style={styles.buttonLabel}>{running ? 'Running…' : 'Import pushed fixture'}</Text>
        </Pressable>

        <Pressable style={styles.button} onPress={run(runSortScenarios)} accessibilityRole="button">
          <Text style={styles.buttonLabel}>{running ? 'Running…' : 'Run sort scenarios'}</Text>
        </Pressable>

        {/*
          N4 criteria 11–13. The counter-test for 13 is one of the scenarios
          rather than a code edit: same fixture, no skip set, and the directory
          has to be taken — otherwise the guard above it proves nothing.
        */}
        <Pressable
          style={styles.button}
          onPress={run(runSweepScenarios)}
          accessibilityRole="button"
        >
          <Text style={styles.buttonLabel}>{running ? 'Running…' : 'Run sweep scenarios'}</Text>
        </Pressable>

        {/*
          The AudioLandingContract's second hook, plus criteria 7 and 8. Needs
          the two probe tracks and the ffprobe reading they are measured
          against: `just mobile-push-audio-fixtures`, after this build has made
          `lark-fixture/` once.
        */}
        <Pressable
          style={styles.button}
          onPress={run(runAudioLandingScenarios)}
          accessibilityRole="button"
        >
          <Text style={styles.buttonLabel}>{running ? 'Running…' : 'Run landing scenarios'}</Text>
        </Pressable>

        {/*
          Criterion 4, and the acts half of 3③. The product cannot hold a
          broken audio file — nothing can push one into `Paths.document` and no
          screen can make one — so this is the only artifact where "what does
          the player do with a file that is not audio" can be asked at all.
          The host counts active players afterwards.
        */}
        <Pressable
          style={styles.button}
          onPress={run(runPlaybackScenarios)}
          accessibilityRole="button"
        >
          <Text style={styles.buttonLabel}>{running ? 'Running…' : 'Run playback scenarios'}</Text>
        </Pressable>

        {/*
          Criterion 12③ is two buttons because it is two processes. The first
          stops the drain half-done and stays there; the driver force-stops the
          app; the second asks the next boot what it made of the wreckage.
        */}
        <Pressable style={styles.button} onPress={run(armMidDrainKill)} accessibilityRole="button">
          <Text style={styles.buttonLabel}>{running ? 'Running…' : 'Arm mid drain kill'}</Text>
        </Pressable>

        <Pressable style={styles.button} onPress={run(resumeAfterKill)} accessibilityRole="button">
          <Text style={styles.buttonLabel}>{running ? 'Running…' : 'Resume after kill'}</Text>
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
