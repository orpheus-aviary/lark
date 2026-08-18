// The judgement panel (N0b-1 boot probes, N0b-2 contract + bootstrap, N0b-3
// jank / crypto / globals).
//
// Everything runs on demand rather than on mount: the contract's lifecycle
// group does 13k statement executions synchronously, and a panel that froze for
// several seconds every time Metro reloaded would be unusable. The freeze while
// it runs is expected — that is what "the sync API blocks the JS thread" means,
// and criterion 18 is where it gets measured properly.
//
// Every N0b-3 panel also POSTs its result to the desktop probe host, because
// its numbers only count on a release build and a release build has no Metro to
// print to (see `report.ts`).

import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BUILD_IS_DEV, RUNTIME_LABEL } from './measure';
import { type NetProbeRow, runBilibiliPanel } from './panels/bilibili';
import { type BootstrapStep, rehearseFreshLibrary } from './panels/bootstrap';
import { type ContractRun, runContract } from './panels/contract';
import { type CryptoRow, runCryptoPanel } from './panels/crypto';
import { type LifecycleProbe, probeDrizzleLifecycle } from './panels/drizzle-lifecycle';
import { type MatrixRun, runDrizzleMatrix } from './panels/drizzle-matrix';
import { type GlobalRow, runGlobalsPanel } from './panels/globals';
import { type SyncProbeRow, runSkybridgePanel } from './panels/skybridge';
import {
  type WorkloadRow,
  derivedBatchSize,
  measureApply,
  measureBackfill,
  measureColdStarts,
} from './panels/workload';
import { bootProbes } from './probes';
import { reportToHost } from './report';
import { expoSqliteHooks } from './sqlite/hooks';
import { opSqliteHooks } from './sqlite/op-sqlite-hooks';

const STATUS_COLOR = {
  pass: '#22c55e',
  fail: '#ef4444',
  skip: '#a1a1aa',
} as const;

// A polyfill is as good as native for our purposes — both mean "nothing to do".
// `port` and `unverified` are the two that create work, and they read
// differently on purpose: one is an answer, the other is a missing one.
const VERDICT_COLOR = {
  native: '#22c55e',
  polyfill: '#38bdf8',
  port: '#f59e0b',
  unverified: '#ef4444',
} as const;

export function App() {
  const probes = bootProbes();
  const [contract, setContract] = useState<ContractRun | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapStep[] | null>(null);
  const [drizzle, setDrizzle] = useState<LifecycleProbe | null>(null);
  const [matrix, setMatrix] = useState<MatrixRun | null>(null);
  const [workload, setWorkload] = useState<WorkloadRow[] | null>(null);
  const [crypto, setCrypto] = useState<CryptoRow[] | null>(null);
  const [globals, setGlobals] = useState<GlobalRow[] | null>(null);
  const [bilibili, setBilibili] = useState<NetProbeRow[] | null>(null);
  const [skybridge, setSkybridge] = useState<SyncProbeRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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

  const runAsync = (fn: () => Promise<void>) => () => {
    setCrashed(null);
    fn().catch((err: unknown) => {
      setCrashed(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    });
  };

  // The network panels take tens of seconds (real requests, a 15s SSE wait),
  // and a panel that looks idle while it works is one the driver script cannot
  // wait for. `busy` is that signal, and it is also what `drive.mjs` polls.
  const runNetwork =
    <T,>(label: string, fn: () => Promise<T>, set: (rows: T) => void) =>
    () => {
      setCrashed(null);
      setBusy(label);
      fn()
        .then((rows) => {
          set(rows);
          reportToHost(label, { runtime: RUNTIME_LABEL, dev: BUILD_IS_DEV, rows });
        })
        .catch((err: unknown) => {
          setCrashed(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
        })
        .finally(() => {
          setBusy(null);
        });
    };

  const workloadRun = (label: string, fn: () => WorkloadRow[]) => () => {
    const rows = fn();
    setWorkload(rows);
    for (const r of rows) {
      console.log(
        `WORKLOAD ${r.ok === null ? '·' : r.ok ? 'PASS' : 'FAIL'} | ${r.scenario} | ${r.timing.label} | p50 ${r.timing.p50}ms p95 ${r.timing.p95}ms max ${r.timing.max}ms over ${r.timing.samples} | ${r.note}`,
      );
    }
    reportToHost(`workload-${label}`, { runtime: RUNTIME_LABEL, dev: BUILD_IS_DEV, rows });
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
        <Pressable
          style={styles.button}
          onPress={run(() => setContract(runContract(opSqliteHooks())))}
        >
          <Text style={styles.buttonText}>Run contract on op-sqlite (criterion 16)</Text>
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

        <Text style={styles.section}>patched drizzle driver (criterion 17b)</Text>
        <Pressable
          style={styles.button}
          onPress={run(() => {
            const result = runDrizzleMatrix();
            setMatrix(result);
            for (const r of result.rows) {
              console.log(`MATRIX ${r.ok ? 'PASS' : 'FAIL'} | ${r.name} | ${r.detail}`);
            }
            console.log(
              `MATRIX SUMMARY | ${result.rows.filter((r) => r.ok).length}/${result.rows.length} | prepared ${result.prepared} | finalized ${result.finalized} | leaked ${result.leaked}`,
            );
          })}
        >
          <Text style={styles.buttonText}>Run drizzle matrix</Text>
        </Pressable>
        {matrix ? (
          <>
            <Text style={styles.summary}>
              {matrix.rows.filter((r) => r.ok).length}/{matrix.rows.length} · prepared{' '}
              {matrix.prepared} · finalized {matrix.finalized} · leaked {matrix.leaked}
            </Text>
            {matrix.rows.map((r) => (
              <View key={r.name} style={styles.row}>
                <Text
                  style={[styles.rowTitle, { color: r.ok ? STATUS_COLOR.pass : STATUS_COLOR.fail }]}
                >
                  {r.ok ? '✓' : '✗'} {r.name}
                </Text>
                <Text style={styles.detail}>{r.detail}</Text>
              </View>
            ))}
          </>
        ) : null}

        <Text style={styles.section}>jank proxy (criterion 18) — release builds only</Text>
        <Text style={[styles.detail, BUILD_IS_DEV ? styles.warning : null]}>
          Statement-shape proxies, not core. {RUNTIME_LABEL}
        </Text>
        <Pressable
          style={styles.button}
          onPress={run(workloadRun('cold-start', measureColdStarts))}
        >
          <Text style={styles.buttonText}>Cold start (max of 5)</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={run(workloadRun('backfill', measureBackfill))}>
          <Text style={styles.buttonText}>Login backfill (2k songs, whole + segments)</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={run(workloadRun('apply', measureApply))}>
          <Text style={styles.buttonText}>Foreground sync round (apply batches)</Text>
        </Pressable>
        {workload?.map((r) => (
          <View key={r.timing.label} style={styles.row}>
            <Text
              style={[
                styles.rowTitle,
                {
                  color:
                    r.ok === null
                      ? STATUS_COLOR.skip
                      : r.ok
                        ? STATUS_COLOR.pass
                        : STATUS_COLOR.fail,
                },
              ]}
            >
              {r.ok === null ? '·' : r.ok ? '✓' : '✗'} {r.timing.label}
            </Text>
            <Text style={styles.detail}>
              p50 {r.timing.p50}ms · p95 {r.timing.p95}ms · max {r.timing.max}ms · n=
              {r.timing.samples} · {r.note}
            </Text>
          </View>
        ))}
        {workload ? (
          <Text style={styles.summary}>
            largest batch inside the 100ms budget:{' '}
            {['login backfill', 'foreground sync round']
              .map((s) => `${s} ${derivedBatchSize(workload, s) ?? 'none'}`)
              .join(' · ')}
          </Text>
        ) : null}

        <Text style={styles.section}>crypto port (criterion 20)</Text>
        <Pressable
          style={styles.button}
          onPress={runAsync(async () => {
            setCrypto(null);
            const rows = await runCryptoPanel();
            setCrypto(rows);
            for (const r of rows) {
              console.log(
                `CRYPTO ${r.ok === null ? '·' : r.ok ? 'PASS' : 'FAIL'} | ${r.name} | ${r.detail}${r.perCallMs === null ? '' : ` | ${r.perCallMs}ms per call`}`,
              );
            }
            reportToHost('crypto', { runtime: RUNTIME_LABEL, dev: BUILD_IS_DEV, rows });
          })}
        >
          <Text style={styles.buttonText}>Run crypto (noble vs the desktop's digests)</Text>
        </Pressable>
        {crypto?.map((r) => (
          <View key={r.name} style={styles.row}>
            <Text
              style={[
                styles.rowTitle,
                {
                  color:
                    r.ok === null
                      ? STATUS_COLOR.skip
                      : r.ok
                        ? STATUS_COLOR.pass
                        : STATUS_COLOR.fail,
                },
              ]}
            >
              {r.ok === null ? '·' : r.ok ? '✓' : '✗'} {r.name}
            </Text>
            <Text style={styles.detail}>
              {r.detail}
              {r.perCallMs === null ? '' : ` · ${r.perCallMs}ms per call (batch)`}
            </Text>
          </View>
        ))}

        <Text style={styles.section}>web standard surface (criterion 21)</Text>
        <Text style={styles.detail}>
          The fetch rows need `just spike-mobile-probe-host`; without it they report unverified.
        </Text>
        <Pressable
          style={styles.button}
          onPress={runAsync(async () => {
            setGlobals(null);
            const rows = await runGlobalsPanel();
            setGlobals(rows);
            for (const r of rows) {
              console.log(`GLOBALS ${r.verdict.toUpperCase()} | ${r.api} | ${r.detail}`);
            }
            reportToHost('globals', { runtime: RUNTIME_LABEL, dev: BUILD_IS_DEV, rows });
          })}
        >
          <Text style={styles.buttonText}>Sweep the globals</Text>
        </Pressable>
        {globals?.map((r) => (
          <View key={r.api} style={styles.row}>
            <Text style={[styles.rowTitle, { color: VERDICT_COLOR[r.verdict] }]}>
              [{r.verdict}] {r.api}
            </Text>
            <Text style={styles.detail}>{r.detail}</Text>
            <Text style={styles.ms}>{r.usedBy}</Text>
          </View>
        ))}

        <Text style={styles.section}>bilibili + audio stream (criteria 23, 19's probe)</Text>
        <Text style={styles.detail}>
          Fixtures come from the desktop's real core over the probe host; run `just
          spike-mobile-fixtures-network` first, and note which network the phone is on.
        </Text>
        <Pressable
          style={styles.button}
          onPress={runNetwork('bilibili', runBilibiliPanel, setBilibili)}
        >
          <Text style={styles.buttonText}>Probe bilibili</Text>
        </Pressable>
        {bilibili?.map((r) => (
          <View key={`${r.group}/${r.name}`} style={styles.row}>
            <Text
              style={[
                styles.rowTitle,
                {
                  color:
                    r.ok === null
                      ? STATUS_COLOR.skip
                      : r.ok
                        ? STATUS_COLOR.pass
                        : STATUS_COLOR.fail,
                },
              ]}
            >
              {r.ok === null ? '·' : r.ok ? '✓' : '✗'} {r.group} › {r.name}
            </Text>
            <Text style={styles.detail}>{r.detail}</Text>
          </View>
        ))}

        <Text style={styles.section}>skybridge SDK (criterion 22)</Text>
        <Text style={styles.detail}>
          Needs `just spike-mobile-sync-host`. login / pushChanges / pullChanges / refresh are the
          four hard gates; SSE is soft.
        </Text>
        <Pressable
          style={styles.button}
          onPress={runNetwork('skybridge', runSkybridgePanel, setSkybridge)}
        >
          <Text style={styles.buttonText}>Run skybridge probes</Text>
        </Pressable>
        {skybridge ? (
          <Text style={styles.summary}>
            gates {skybridge.filter((r) => r.gate && r.ok === true).length}/
            {skybridge.filter((r) => r.gate).length} ·{' '}
            {skybridge.filter((r) => r.ok === false).length} failed
          </Text>
        ) : null}
        {skybridge?.map((r) => (
          <View key={r.name} style={styles.row}>
            <Text
              style={[
                styles.rowTitle,
                {
                  color:
                    r.ok === null
                      ? STATUS_COLOR.skip
                      : r.ok
                        ? STATUS_COLOR.pass
                        : STATUS_COLOR.fail,
                },
              ]}
            >
              {r.ok === null ? '·' : r.ok ? '✓' : '✗'} {r.name}{' '}
              <Text style={styles.ms}>{r.ms}ms</Text>
            </Text>
            <Text style={styles.detail}>{r.detail}</Text>
          </View>
        ))}

        {busy ? <Text style={styles.busy}>running {busy}…</Text> : null}
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
  busy: { color: '#f59e0b', fontSize: 13, marginTop: 12 },
  crashed: { color: '#ef4444', fontSize: 13, marginTop: 12 },
  warning: { color: '#f59e0b' },
  button: {
    backgroundColor: '#27272a',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  buttonText: { color: '#f4f4f5', fontSize: 14, fontWeight: '500' },
});
