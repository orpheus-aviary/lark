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

import { type ReactNode, useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput } from 'react-native';
import { useKeyboardSheetInset } from './keyboard';
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
  // 🔴 A DIALOG IS ITS OWN WINDOW, so the room made at the app root is not
  // made here (`ui/keyboard.ts`). Without this the platform PANS the dialog
  // to reveal whatever has focus, which leaves everything BELOW the field —
  // 保存, 取消, the submit button — under the keyboard. With the card already
  // above it, there is nothing to reveal and no pan happens.
  const inset = useKeyboardSheetInset();
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <Pressable
        style={[styles.backdrop, { paddingBottom: inset }]}
        onPress={onClose}
        accessibilityRole="button"
      >
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
 * IT STARTS WITH THE CURRENT VALUE SELECTED, and HOW it does that is the half
 * that was wrong. Renaming is usually an edit rather than a retype, and
 * `adb shell input text` appends at the cursor — so prefilled-and-selected is
 * both what a person wants and the only shape an acceptance run can drive
 * (`scripts/drive.mjs`).
 *
 * 🔴 NOT `selectTextOnFocus` (2026-09-02, 用户报的「编辑一下之后会进入全选」).
 * That prop lands as a FIELD on the native `ReactEditText`, and its `onLayout`
 * re-selects everything whenever the field is still armed. Fabric re-sends the
 * WHOLE prop map on every update, so a CONTROLLED `value` re-armed it on every
 * keystroke: a few characters in, the next layout — the IME candidate bar
 * appearing is enough — selects the line, and the following key replaces it.
 *
 * So, two halves, and both are needed:
 *
 *   UNCONTROLLED, so typing re-renders nothing and no props are re-sent. The
 *   value lives in a ref because the only reader is 确认.
 *
 *   ONE IMPERATIVE `setSelection`, which is a command rather than a prop and
 *   therefore cannot be repeated by an update. On the FIRST focus only:
 *   coming back to a field to carry on editing must not select what is
 *   already there.
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
  const input = useRef<TextInput>(null);
  const value = useRef(initial);
  const selected = useRef(false);
  const inset = useKeyboardSheetInset();
  return (
    <Modal
      transparent
      animationType="fade"
      visible
      onRequestClose={onClose}
      // 🔴 NOT `autoFocus` (2026-09-02, 用户: 「现在不会自动唤起输入法」).
      // `autoFocus` is applied in `onAttachedToWindow`, and RN clears the
      // dialog window's FLAG_NOT_FOCUSABLE on the line AFTER `dialog.show()` —
      // so the focus request lands on a window that cannot take focus yet and
      // `showSoftInput` fails silently. It has always been a race; it only
      // became visible when the field stopped selecting itself.
      //
      // `onShow` cannot lose it: `Dialog.show()` posts the show callback
      // through a handler, so it is delivered after that line has run.
      onShow={() => input.current?.focus()}
    >
      <Pressable
        style={[styles.backdrop, { paddingBottom: inset }]}
        onPress={onClose}
        accessibilityRole="button"
      >
        <Pressable style={styles.card} onPress={() => undefined}>
          <Text style={styles.title}>{title}</Text>
          <TextInput
            ref={input}
            style={styles.input}
            defaultValue={initial}
            onChangeText={(next) => {
              value.current = next;
            }}
            onFocus={() => {
              if (selected.current) return;
              selected.current = true;
              input.current?.setSelection(0, initial.length);
            }}
            accessibilityLabel={title}
          />
          <SheetAction label={confirmLabel} onPress={() => onConfirm(value.current)} />
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
