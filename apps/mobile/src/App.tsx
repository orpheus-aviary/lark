// The first screen (N2a, criterion 1).
//
// It is deliberately three lines of text, and two of them are read out of the
// packages this app is allowed to link. That is the point: `just
// mobile-bundle-smoke` asserts the portable barrel is IN the built module
// graph, and a screen that imported nothing would let that assertion pass
// while proving nothing (N1i's "the probe has to sit somewhere the barrel can
// reach" — an isolated file is not in the graph and stays green no matter what
// you put in it).
//
// Everything else arrives with its batch: the database in N2b, the identity
// gate in N2c, the four tabs in N2f. Nothing here opens a file.

import { LATEST_KNOWN_VERSION } from '@lark/core/portable';
import { LOCAL_API_VERSION } from '@lark/shared/api-paths';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';

export function App() {
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.body}>
        <Text style={styles.title}>lark</Text>
        <Text style={styles.line}>schema v{LATEST_KNOWN_VERSION}</Text>
        <Text style={styles.line}>protocol v{LOCAL_API_VERSION}</Text>
        <Text style={styles.note}>N2a：脚手架。曲库、身份门与四 tab 还没到。</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#09090b' },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  title: { color: '#fafafa', fontSize: 32, fontWeight: '600', marginBottom: 8 },
  line: { color: '#a1a1aa', fontSize: 15, fontVariant: ['tabular-nums'] },
  note: { color: '#52525b', fontSize: 13, marginTop: 20 },
});
