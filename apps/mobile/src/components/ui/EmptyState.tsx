import { StyleSheet, Text, View } from "react-native";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

/**
 * `compact` is for an empty state that sits INSIDE a titled Card (or right
 * above its own retry button): the Card already pads by spacing.xl and its
 * title by spacing.lg, so any top padding here stacks on that and pushes the
 * heading->content gap past the sibling cards' — compact adds none, only a
 * little air below. It is also START-aligned, like the rows it stands in for
 * inside a start-aligned Card; the centred variant is for full-page empties.
 */
export function EmptyState({
  title,
  hint,
  compact = false,
}: {
  title: string;
  hint?: string;
  compact?: boolean;
}) {
  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      <Text style={[styles.title, compact && styles.startText]}>{title}</Text>
      {hint ? <Text style={[styles.hint, compact && styles.startText]}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", paddingVertical: spacing.xxl * 1.5, gap: spacing.sm },
  wrapCompact: { alignItems: "flex-start", paddingTop: 0, paddingBottom: spacing.sm },
  title: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, textAlign: "center" },
  hint: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, textAlign: "center" },
  // Listed after title/hint so START wins over "center" in compact mode.
  startText: { ...RTL_TEXT },
});
