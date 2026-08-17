// The judgement panel (N0b-1 boot probes, N0b-2 contract + bootstrap).
//
// Everything runs on demand rather than on mount: the contract's lifecycle
// group does 13k statement executions synchronously, and a panel that froze for
// several seconds every time Metro reloaded would be unusable. The freeze while
// it runs is expected — that is what "the sync API blocks the JS thread" means,
// and criterion 18 is where it gets measured properly.

import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { type BootstrapStep, rehearseFreshLibrary } from './panels/bootstrap';
import { type ContractRun, runContract } from './panels/contract';
import { type LifecycleProbe, probeDrizzleLifecycle } from './panels/drizzle-lifecycle';
import { bootProbes } from './probes';
import { expoSqliteHooks } from './sqlite/hooks';

const STATUS_COLOR = {
  pass: '#22c55e',
  fail: '#ef4444',
  skip: '#a1a1aa',
} as const;

export function App() {
  const probes = bootProbes();
  const [contract, setContract] = useState<ContractRun | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapStep[] | null>(null);
  const [drizzle, setDrizzle] = useState<LifecycleProbe | null>(null);
  const [crashed, setCrashed] = useState<string | null>(null);

  const run = (fn: () => void) => () => {
    setCrashed(null);
    try {
      fn();
    } catch (err) {
      // A throw out of the runner itself is a different failure from a case
      // failing, and it must not look like "nothing happened".
      setCrashed(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>lark · mobile foundation spike</Text>

        <Text style={styles.section}>workspace resolution (N0b-1)</Text>
        {probes.map((probe) => (
          <View key={probe.source} style={styles.row}>
            <Text style={styles.rowTitle}>{probe.source}</Text>
            <Text style={styles.detail}>{probe.detail}</Text>
          </View>
        ))}

        <Text style={styles.section}>fresh library bootstrap (criterion 15)</Text>
        <Pressable
          style={styles.button}
          onPress={run(() => setBootstrap(rehearseFreshLibrary(expoSqliteHooks())))}
        >
          <Text style={styles.buttonText}>Run bootstrap</Text>
        </Pressable>
        {bootstrap?.map((step) => (
          <View key={step.name} style={styles.row}>
            <Text
              style={[styles.rowTitle, { color: step.ok ? STATUS_COLOR.pass : STATUS_COLOR.fail }]}
            >
              {step.ok ? '✓' : '✗'} {step.name}
            </Text>
            <Text style={styles.detail}>{step.detail}</Text>
          </View>
        ))}

        <Text style={styles.section}>database contract (criterion 14)</Text>
        <Pressable
          style={styles.button}
          onPress={run(() => setContract(runContract(expoSqliteHooks())))}
        >
          <Text style={styles.buttonText}>Run contract</Text>
        </Pressable>
        <Pressable
          style={styles.button}
          onPress={run(() => setContract(runContract(expoSqliteHooks({ leakOnError: true }))))}
        >
          <Text style={styles.buttonText}>Run contract (leaky shim — must fail)</Text>
        </Pressable>
        {contract ? (
          <>
            <Text style={styles.summary}>
              {contract.passed} passed · {contract.failed} failed · {contract.skipped} skipped ·{' '}
              {contract.totalMs}ms
            </Text>
            {contract.rows.map((r) => (
              <View key={`${r.group}/${r.name}`} style={styles.row}>
                <Text style={[styles.rowTitle, { color: STATUS_COLOR[r.status] }]}>
                  {r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '–'} {r.group} › {r.name}{' '}
                  <Text style={styles.ms}>{r.ms}ms</Text>
                </Text>
                {r.detail ? <Text style={styles.detail}>{r.detail}</Text> : null}
              </View>
            ))}
          </>
        ) : null}

        <Text style={styles.section}>drizzle statement lifecycle (criterion 17a)</Text>
        <Pressable
          style={styles.button}
          onPress={run(() => {
            const probe = probeDrizzleLifecycle(10_000);
            setDrizzle(probe);
            console.log(
              `DRIZZLE | ${probe.queries} queries | prepared ${probe.prepared} | finalized ${probe.finalized} | leaked ${probe.leaked} | ${probe.ms}ms`,
            );
          })}
        >
          <Text style={styles.buttonText}>Probe 10k drizzle queries</Text>
        </Pressable>
        {drizzle ? (
          <View style={styles.row}>
            <Text
              style={[
                styles.rowTitle,
                { color: drizzle.leaked === 0 ? STATUS_COLOR.pass : STATUS_COLOR.fail },
              ]}
            >
              {drizzle.leaked === 0 ? '✓ balanced' : `✗ leaked ${drizzle.leaked}`}
            </Text>
            <Text style={styles.detail}>
              {drizzle.queries} queries · prepared {drizzle.prepared} · finalized{' '}
              {drizzle.finalized} · {drizzle.ms}ms
            </Text>
          </View>
        ) : null}

        {crashed ? <Text style={styles.crashed}>runner threw: {crashed}</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#101014' },
  content: { padding: 20, paddingTop: 56, paddingBottom: 64, gap: 12 },
  title: { color: '#f4f4f5', fontSize: 20, fontWeight: '600' },
  section: { color: '#f59e0b', fontSize: 13, fontWeight: '600', marginTop: 16 },
  summary: { color: '#f4f4f5', fontSize: 14 },
  row: { gap: 2, borderLeftWidth: 2, borderLeftColor: '#27272a', paddingLeft: 10 },
  rowTitle: { color: '#f4f4f5', fontSize: 13 },
  detail: { color: '#a1a1aa', fontSize: 12 },
  ms: { color: '#52525b', fontSize: 11 },
  crashed: { color: '#ef4444', fontSize: 13, marginTop: 12 },
  button: {
    backgroundColor: '#27272a',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  buttonText: { color: '#f4f4f5', fontSize: 14, fontWeight: '500' },
});
