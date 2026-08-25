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
import {
  armDurationDuringPlayback,
  armLandingKill,
  resumeAfterLandingKill,
  runAudioLandingScenarios,
  stopDurationDuringPlayback,
} from './audio-landing';
import { type ScenarioRow, runD16Scenarios } from './d16';
import { runDownloadScenarios } from './downloads';
import { armMidDrainKill, resumeAfterKill, runFileOpScenarios } from './file-ops';
import { runFixtureImportScenarios } from './fixture-import';
import {
  armDegradedInjected,
  armForegroundParked,
  armFromBackground,
  armLongDownloadWithService,
  armLongDownloadWithoutService,
  armPlaybackAndDownload,
  checkBackgroundArm,
  checkLongDownload,
  releaseLongDownload,
  serviceStopsForReal,
  stopPlaybackAndDownload,
} from './foreground';
import { runFileSystemScenarios } from './fs';
import { runLibraryContractScenarios } from './library-contract';
import { runPlaybackScenarios } from './playback';
import { runImportDigestScenarios } from './playlist-import';
import { runReidentifyScenarios } from './reidentify';
import { runSortScenarios } from './sort';
import { runSweepScenarios } from './sweep';

/**
 * Every suite the panel can run, in the order they appear.
 *
 * A LIST AND NOT SEVENTEEN `Pressable`s, since N4c. The hand-written version
 * grew one block per criterion and had started to read as a wall — and the
 * thing each block was really carrying, the note about how to run it, was
 * buried in a JSX comment where nothing could show it to the person holding the
 * phone. Here the note is data, and the panel prints it.
 */
const SUITES: readonly { label: string; run: () => Promise<ScenarioRow[]>; note?: string }[] = [
  { label: 'Run D16 scenarios', run: runD16Scenarios },
  { label: 'Run library contract', run: runLibraryContractScenarios },
  { label: 'Run file system scenarios', run: runFileSystemScenarios },
  { label: 'Run file op scenarios', run: runFileOpScenarios },
  {
    label: 'Import pushed fixture',
    run: runFixtureImportScenarios,
    // The one fixture that has to be pushed rather than synthesised: a library
    // the DESKTOP wrote.
    note: 'needs `just mobile-push-fixture`; tap once first to make the directory',
  },
  { label: 'Run sort scenarios', run: runSortScenarios },
  {
    label: 'Run import digest scenarios',
    run: runImportDigestScenarios,
    // Nothing to push and nothing to set up: the fixture is a string in the
    // bundle and the big inputs are synthesised. The 20MB case allocates,
    // hashes and frees 20MB five times, so give it a moment.
    note: '86 · 87 — 20MB × 5 takes a few seconds; no fixture needed',
  },
  {
    label: 'Run sweep scenarios',
    run: runSweepScenarios,
    // Criterion 13's counter-test is one of the scenarios rather than a code
    // edit: same fixture, no skip set, and the directory has to be taken.
    note: '11 · 12 · 13, counter-tests included',
  },
  {
    label: 'Run landing scenarios',
    run: runAudioLandingScenarios,
    note: '7 · 8 · 10 — needs `just mobile-push-audio-fixtures`',
  },
  {
    label: 'Run download scenarios',
    run: runDownloadScenarios,
    // playurl picks the CDN node by the caller's IP, so one network says
    // nothing about the other.
    note: '5 · 6 · 14 — run on Wi-Fi AND on mobile data; leaves 6ʼs song behind on purpose',
  },
  {
    label: 'Run reidentify scenarios',
    run: runReidentifyScenarios,
    // It runs on the library that is THERE, on purpose: the model lives in
    // `local_metadata`, so a suite that reset the install would have deleted
    // the configuration ③ is about.
    note: '29 — 先在生产构建的设置页填好模型；不要在它之前跑任何会重置安装的套件',
  },
  {
    label: 'Arm long download',
    run: armLongDownloadWithService,
    note: '15 — then screen off, wait, wake, and Check',
  },
  {
    label: 'Arm long download no service',
    run: armLongDownloadWithoutService,
    // If this one finishes too, criterion 15 proved nothing about the service.
    note: '15 counter-test — the same download with nothing holding the process up',
  },
  { label: 'Check long download', run: checkLongDownload, note: '15 — answered from disk too' },
  { label: 'Release long download', run: releaseLongDownload },
  {
    label: 'Arm foreground',
    run: armForegroundParked,
    // The park is the criterion: nothing is enqueued and the service has to be
    // up anyway, which is the whole claim of `arming`.
    note: '17①② — parks 25s with nothing enqueued, then downloads the short one; dumpsys during the park',
  },
  {
    label: 'Arm degraded',
    run: armDegradedInjected,
    note: '17③ — the refusal is injected, so it happens every time; the download must finish anyway',
  },
  {
    label: 'Arm from background',
    run: armFromBackground,
    // Android is the one answering here, which is why it is not an injection.
    note: '17 counter-test — then press HOME; it arms from the AppState callback',
  },
  {
    label: 'Check background arm',
    run: checkBackgroundArm,
    note: '17 counter-test — read after coming back; dumpsys during the window is the real answer',
  },
  {
    label: 'Stop service twice',
    run: serviceStopsForReal,
    note: '21 — six seconds up for dumpsys and the shade, then stopped twice',
  },
  {
    label: 'Arm two services',
    run: armPlaybackAndDownload,
    note: '22 — music plus the long download; count both services and both notifications',
  },
  { label: 'Stop two services', run: stopPlaybackAndDownload, note: '22 — the music must survive' },
  {
    label: 'Arm criterion 9',
    run: armDurationDuringPlayback,
    // The important half is not JS's to see: how many AudioTracks the system
    // holds is a `dumpsys audio` fact.
    note: '9 — parks with the music going; count active players from the host',
  },
  { label: 'Stop criterion 9', run: stopDurationDuringPlayback },
  {
    label: 'Arm landing kill',
    run: armLandingKill,
    // A throw unwinds where SIGKILL does not, so this parks and the driver
    // force-stops it.
    note: '11 — force-stop while it is parked, then relaunch and Resume',
  },
  { label: 'Resume after landing kill', run: resumeAfterLandingKill },
  {
    label: 'Run playback scenarios',
    run: runPlaybackScenarios,
    // The product cannot hold a broken audio file, so this is the only
    // artifact where the question can be asked at all.
    note: '4 · 3③ — the host counts active players afterwards',
  },
  {
    label: 'Arm mid drain kill',
    run: armMidDrainKill,
    note: '12③ — force-stop while parked, then relaunch and Resume',
  },
  { label: 'Resume after kill', run: resumeAfterKill },
];

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
          sweep — 11, 12, 13 · landing — 7, 8, 9, 10, 11 · downloads — 5, 6, 14 · foreground — 15
        </Text>

        {SUITES.map((suite) => (
          <View key={suite.label}>
            <Pressable style={styles.button} onPress={run(suite.run)} accessibilityRole="button">
              {/*
                The label NEVER becomes "Running…". `drive.mjs` finds buttons by
                their label, and a panel that renames every one of them while a
                suite runs is a panel the driver cannot press twice.
              */}
              <Text style={styles.buttonLabel}>{suite.label}</Text>
            </Pressable>
            {suite.note !== undefined && <Text style={styles.note}>{suite.note}</Text>}
          </View>
        ))}

        {running && <Text style={styles.line}>Running…</Text>}

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
  note: { color: '#71717a', fontSize: 12, marginTop: 4 },
  verdict: { marginTop: 16, fontSize: 15, fontWeight: '600' },
  row: { marginTop: 10 },
  rowName: { fontSize: 14 },
  rowDetail: { color: '#71717a', fontSize: 12, marginTop: 2 },
  pass: { color: '#22c55e' },
  fail: { color: '#ef4444' },
});
