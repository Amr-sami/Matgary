import { Pressable, StyleSheet, Text } from "react-native";

import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Filter chip. Active is accent-filled with white text — the web briefly used
 * green here, which reads as "paid / ok" rather than "selected"; that was fixed
 * on the web and must not come back (session-record §1d).
 *
 * `numberOfLines={1}` plus `flexShrink: 0` is the fix for the defect that
 * started the polish pass: a flex child defaults to shrinking, and for text
 * min-content means breaking at every space, so "آخر 7 أيام" rendered one word
 * per line in a 70px chip.
 *
 * The label is centred in BOTH axes, on purpose (no RTL_TEXT here): a chip
 * usually hugs its label, but a caller may stretch it to fill a cell (the
 * expenses category grid puts each chip in a 48% column, and a column's default
 * align is stretch). With start alignment the stretched chip read as an empty
 * text input with a value at the start edge — only the active one looked like a
 * choice. Centring matches Segmented, and is direction-neutral, so it renders
 * the same in Arabic and English.
 */
export function Chip({
  label,
  active = false,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.chip,
        active ? styles.active : styles.inactive,
        pressed && !active && styles.pressed,
      ]}
    >
      <Text
        numberOfLines={1}
        style={[styles.text, active ? styles.textActive : styles.textInactive]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    flexShrink: 0,
  },
  active: { backgroundColor: colors.accent, borderColor: colors.accent },
  inactive: { backgroundColor: colors.bg, borderColor: colors.border },
  pressed: { backgroundColor: colors.accentLight },
  text: { fontFamily: fonts.medium, fontSize: 14, textAlign: "center" },
  textActive: { color: "#FFFFFF" },
  textInactive: { color: colors.text },
});
