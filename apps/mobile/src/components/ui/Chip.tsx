import { Pressable, StyleSheet, Text } from "react-native";

import { RTL_TEXT } from "@/theme/rtl";
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
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    flexShrink: 0,
  },
  active: { backgroundColor: colors.accent, borderColor: colors.accent },
  inactive: { backgroundColor: colors.bg, borderColor: colors.border },
  pressed: { backgroundColor: colors.accentLight },
  text: { fontFamily: fonts.medium, fontSize: 14, ...RTL_TEXT },
  textActive: { color: "#FFFFFF" },
  textInactive: { color: colors.text },
});
