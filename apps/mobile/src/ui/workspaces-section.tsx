// The libraries on this phone (N7e-4).
//
// 🔴 IT SHOWS TWO DIFFERENT FACTS AND MUST NOT COLLAPSE THEM: the library this
// launch OPENED — which is what every screen behind this one is about — and
// the one the next launch will open. They differ from the moment somebody
// switches until they reopen the app, which is exactly the window that needs
// saying out loud.
//
// The confirmation is the one §2.5 asks for, and its words are what makes the
// operation understandable rather than alarming: nothing moves, nothing is
// lost, and the app carries on with what it has open until it is reopened.
//
// ⚠️ NO SONG COUNTS, unlike the desktop's list — `workspace/list.ts` says why:
// this host has no read-only database open, and a settings list is not worth
// copying a library to count its rows.

import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { createFileSystem } from '../ports/fs';
import { switchWorkspace } from '../workspace/index-file';
import { type WorkspaceRow, listWorkspaces, workspaceTitle } from '../workspace/list';
import { C, S } from './theme';

export function WorkspacesSection() {
  const [rows, setRows] = useState<readonly WorkspaceRow[]>(() => listWorkspaces());
  const [said, setSaid] = useState<string | null>(null);

  const apply = useCallback(async (row: WorkspaceRow) => {
    try {
      const result = await switchWorkspace(createFileSystem(), row.id);
      setRows(listWorkspaces());
      if (result.changed) {
        setSaid(`下次打开 lark 会用「${workspaceTitle(row)}」。完全退出再打开一次才会切过去。`);
      }
    } catch (err) {
      setSaid(err instanceof Error ? err.message : '切换失败');
    }
  }, []);

  const confirm = useCallback(
    (row: WorkspaceRow) => {
      Alert.alert(
        '切换曲库需要重启应用',
        '切换只是改一行记录，现在打开的曲库不会受影响。完全退出 lark 再打开，才会用新的曲库；在那之前正在播放和正在下载的都照旧。',
        [
          { text: '取消', style: 'cancel' },
          { text: '同意', onPress: () => void apply(row) },
        ],
      );
    },
    [apply],
  );

  return (
    <View style={styles.section}>
      <Text style={styles.title}>曲库</Text>
      <Text style={styles.note}>
        每个账号在这台手机上有各自的曲库，互不可见；没有登录过的那个在最上面。
      </Text>

      {rows.map((row) => (
        <View key={row.id} style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.name}>
              {workspaceTitle(row)}
              {row.serving && <Text style={styles.tag}>（正在使用）</Text>}
              {row.active && !row.serving && <Text style={styles.pending}>（重启后使用）</Text>}
            </Text>
            {row.server_url !== '' && <Text style={styles.sub}>{row.server_url}</Text>}
          </View>
          {!row.active && (
            <Pressable
              style={styles.button}
              onPress={() => confirm(row)}
              accessibilityRole="button"
              accessibilityLabel={`切换到 ${workspaceTitle(row)}`}
            >
              <Text style={styles.buttonText}>切换</Text>
            </Pressable>
          )}
        </View>
      ))}

      {said !== null && <Text style={styles.said}>{said}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: S.gap },
  title: { color: C.text, fontSize: 16, fontWeight: '600' },
  note: { color: C.muted, fontSize: 12, lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.gap,
    backgroundColor: C.surface,
    borderRadius: S.radius,
    padding: 10,
  },
  rowText: { flex: 1, gap: 2 },
  name: { color: C.text, fontSize: 14 },
  tag: { color: C.muted, fontSize: 12 },
  pending: { color: C.active, fontSize: 12 },
  sub: { color: C.faint, fontSize: 12 },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: S.radius,
    backgroundColor: C.surfaceOn,
    minHeight: 44,
    justifyContent: 'center',
  },
  buttonText: { color: C.text, fontSize: 13 },
  said: { color: C.muted, fontSize: 12, lineHeight: 18 },
});
