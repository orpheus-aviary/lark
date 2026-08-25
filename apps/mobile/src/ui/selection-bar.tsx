// The bar that appears when rows are ticked (N4i-2, criteria 53–57).
//
// It replaces the tab's own controls rather than sitting beside them: on a
// phone, "which mode am I in" has to be answerable at a glance, and two
// toolbars stacked is the layout that makes it unanswerable (§1.7).
//
// THE BACK KEY IS PART OF THIS COMPONENT, and that is the point of putting it
// here rather than in each tab: `BackHandler` is a global stack, and a screen
// that forgets to unregister eats the back press that should have left the
// app. Mounted with the bar, gone with it — the same lifetime, by construction.
//
// Every action carries text, no icon-only controls: the acceptance driver
// finds buttons by label in the accessibility tree (`drive.mjs`), and an icon
// row is a row no run can press.

import { useEffect } from 'react';
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { C, S } from './theme';

export interface SelectionAction {
  label: string;
  danger?: boolean;
  onPress: () => void;
}

export function SelectionBar({
  count,
  everyChosen,
  busy,
  actions,
  onToggleEvery,
  onExit,
}: {
  count: number;
  everyChosen: boolean;
  /** A batch is running: the actions go dead and say so (§2.3). */
  busy: boolean;
  actions: readonly SelectionAction[];
  onToggleEvery: () => void;
  onExit: () => void;
}) {
  // The one external system this component synchronises with: the system back
  // key. Returning `true` means "handled" — without it the press leaves the
  // app while a selection is still on screen, which is the first thing an
  // Android user does to get out of a mode.
  //
  // NOT while a batch runs: leaving would drop the selection under an
  // operation that is still deleting things out of it.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy) return true;
      onExit();
      return true;
    });
    return () => subscription.remove();
  }, [busy, onExit]);

  return (
    <View style={styles.bar}>
      <View style={styles.head}>
        <Text style={styles.count}>已选 {count} 首</Text>
        {busy && <ActivityIndicator size="small" color={C.muted} />}
        <Pressable
          style={styles.plain}
          onPress={onToggleEvery}
          disabled={busy}
          accessibilityRole="button"
        >
          <Text style={styles.plainLabel}>{everyChosen ? '全不选' : '全选'}</Text>
        </Pressable>
        <Pressable
          style={styles.plain}
          onPress={onExit}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="退出选择"
        >
          <Text style={styles.plainLabel}>完成</Text>
        </Pressable>
      </View>
      <View style={styles.actions}>
        {actions.map((action) => (
          <Pressable
            key={action.label}
            style={[styles.action, busy && styles.off]}
            onPress={action.onPress}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={[styles.actionLabel, action.danger === true && styles.danger]}>
              {action.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: S.pad, paddingBottom: S.gap, gap: S.gap },
  head: { flexDirection: 'row', alignItems: 'center', gap: S.gap },
  count: { flex: 1, color: C.text, fontSize: 15, fontWeight: '600' },
  plain: { paddingHorizontal: 8, paddingVertical: 6 },
  plainLabel: { color: C.muted, fontSize: 14 },
  // Wraps: four actions do not fit one line on a narrow phone, and a row that
  // scrolls sideways hides the destructive one.
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: S.gap },
  action: {
    backgroundColor: C.surface,
    borderRadius: S.radius,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 36,
    justifyContent: 'center',
  },
  actionLabel: { color: C.text, fontSize: 14 },
  danger: { color: C.danger },
  off: { opacity: 0.4 },
});
