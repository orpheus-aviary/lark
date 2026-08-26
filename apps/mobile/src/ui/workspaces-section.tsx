// The libraries on this phone (N7e-4).
//
// 🔴 IT SHOWS TWO DIFFERENT FACTS AND MUST NOT COLLAPSE THEM: the library this
// launch OPENED — which is what every screen behind this one is about — and
// the one the next launch will open. They differ from the moment somebody
// switches until they reopen the app, which is exactly the window that needs
// saying out loud.
//
// The confirmation is the one §2.5 asks for, and its words are what makes the
// operation understandable rather than alarming: nothing moves and nothing is
// lost — only this launch ends.
//
// 🔴 AGREEING CLOSES THE APP (N7g-2). The index is one atomic line and only a
// new PROCESS can honour it, so the alternative was to print "completely quit
// lark and open it again" and hope — asking somebody to perform the mechanism,
// and leaving the app sitting in a state its own screen calls out of date.
// `modules/lark-app` says why finishing the Activity is not enough.
//
// ⚠️ NO SONG COUNTS, unlike the desktop's list — `workspace/list.ts` says why:
// this host has no read-only database open, and a settings list is not worth
// copying a library to count its rows.

import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { quitApp } from '../../modules/lark-app';
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
      if (!result.changed) {
        setRows(listWorkspaces());
        return;
      }
      // The index is written and it is atomic, so there is nothing left to
      // finish — and the only thing that can honour it is a new process
      // (`modules/lark-app` says why an Activity is not enough). Telling
      // somebody to swipe the app away themselves was the previous shape; it
      // asked them to perform the mechanism.
      //
      // 🔴 ITS OWN CATCH, because the switch has ALREADY SUCCEEDED by now: a
      // failure to close is not a failure to switch, and reporting it as one
      // would send somebody to undo something that worked.
      try {
        await quitApp();
      } catch {
        setRows(listWorkspaces());
        setSaid(
          `已经记下了：下次打开 lark 会用「${workspaceTitle(row)}」。这次没能自动关闭，完全退出再打开一次即可。`,
        );
      }
    } catch (err) {
      setSaid(err instanceof Error ? err.message : '切换失败');
    }
  }, []);

  const confirm = useCallback(
    (row: WorkspaceRow) => {
      Alert.alert(
        `切换到「${workspaceTitle(row)}」`,
        '切换只是改一行记录，现在这个曲库不会受影响。同意之后 lark 会立刻关闭，重新打开就用新的曲库——正在播放和正在下载的会跟着这次关闭一起停下。',
        [
          { text: '取消', style: 'cancel' },
          { text: '同意并关闭', onPress: () => void apply(row) },
        ],
      );
    },
    [apply],
  );

  return (
    <View style={styles.section}>
      <Text style={styles.title}>曲库</Text>
      <Text style={styles.note}>
        每个账号在这台手机上有各自的曲库，互不可见；没有登录过的那个在最上面。切换时 lark
        会关闭一次，重新打开就在新的曲库里。
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
