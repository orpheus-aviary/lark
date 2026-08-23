// The one chip both forms use (N4e-2).
//
// It was `add-tab.tsx`'s until the settings page needed the same control for
// `api_format`. Two screens drawing two chips that are meant to look identical
// is how a palette drifts — and `theme.ts` can only stop them inventing a
// second grey, not a second shape.

import { Pressable, StyleSheet, Text } from 'react-native';
import { C, S } from './theme';

export function Chip({
  label,
  on,
  disabled = false,
  onPress,
}: { label: string; on: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.chip, on && styles.chipOn, disabled && styles.chipOff]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on, disabled }}
    >
      <Text style={[styles.label, on && styles.labelOn, disabled && styles.labelOff]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: S.radius,
    backgroundColor: C.surface,
  },
  chipOn: { backgroundColor: C.surfaceOn },
  chipOff: { opacity: 0.4 },
  label: { color: C.muted, fontSize: 13 },
  labelOn: { color: C.text },
  labelOff: { color: C.faint },
});
