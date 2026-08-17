// The judgement panel's shell (N0b-1).
//
// N0b-2 onward hangs the real panels off this: the contract harness, the
// migration chain, the jank timings, the crypto benchmark. Right now it renders
// the boot probes, which is exactly what criterion 12 asks for — the three
// workspace packages resolved by Metro on a real device.

import { StatusBar } from 'expo-status-bar';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { bootProbes } from './probes';

export function App() {
  const probes = bootProbes();

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>lark · mobile foundation spike</Text>
        <Text style={styles.subtitle}>N0b-1 · workspace resolution</Text>

        {probes.map((probe) => (
          <View key={probe.source} style={styles.row}>
            <Text style={styles.source}>{probe.source}</Text>
            <Text style={styles.detail}>{probe.detail}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#101014' },
  content: { padding: 20, paddingTop: 64, gap: 16 },
  title: { color: '#f4f4f5', fontSize: 20, fontWeight: '600' },
  subtitle: { color: '#a1a1aa', fontSize: 13, marginTop: -12 },
  row: { gap: 4, borderLeftWidth: 2, borderLeftColor: '#f59e0b', paddingLeft: 12 },
  source: { color: '#f4f4f5', fontSize: 15, fontWeight: '500' },
  detail: { color: '#a1a1aa', fontSize: 13 },
});
