// A sheet and a prompt, built out of RN's own `Modal` (N2f).
//
// No gesture library. The batch that would have needed one — dragging a
// playlist into order — was dropped for the first mobile version (subplan
// §8.3), and everything left is a tap: pick an action, or type a name and
// confirm. `Modal` does that, and three native dependencies would have been
// three native dependencies.
//
// Every control carries its label as TEXT rather than as an icon, because the
// acceptance driver finds buttons by label in the accessibility tree
// (`drive.mjs`). An icon-only row is a row no run can press.

import { type ReactNode, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput } from 'react-native';
import { C, S } from './theme';

export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button">
        {/* Swallow taps inside the card so only the backdrop dismisses. */}
        <Pressable style={styles.card} onPress={() => undefined}>
          <Text style={styles.title}>{title}</Text>
          {children}
          <SheetAction label="取消" onPress={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function SheetAction({
  label,
  onPress,
  danger,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable style={styles.action} onPress={onPress} accessibilityRole="button">
      <Text style={[styles.actionLabel, danger === true && styles.danger]}>{label}</Text>
    </Pressable>
  );
}

/**
 * A one-field prompt.
 *
 * It starts with the current value SELECTED rather than empty: renaming is
 * usually an edit, and `adb shell input text` appends at the cursor, so a
 * prefilled field is also the only shape an acceptance run can drive.
 */
export function Prompt({
  title,
  initial,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  initial: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button">
        <Pressable style={styles.card} onPress={() => undefined}>
          <Text style={styles.title}>{title}</Text>
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={setValue}
            autoFocus
            selectTextOnFocus
            accessibilityLabel={title}
          />
          <SheetAction label={confirmLabel} onPress={() => onConfirm(value)} />
          <SheetAction label="取消" onPress={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: '#000000cc',
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: C.surface,
    borderTopLeftRadius: S.radius * 2,
    borderTopRightRadius: S.radius * 2,
    padding: S.pad,
    gap: 4,
  },
  title: { color: C.muted, fontSize: 13, marginBottom: S.gap },
  action: { paddingVertical: 14 },
  actionLabel: { color: C.text, fontSize: 16 },
  danger: { color: C.danger },
  input: {
    color: C.text,
    fontSize: 16,
    backgroundColor: C.surfaceOn,
    borderRadius: S.radius,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: S.gap,
  },
});
