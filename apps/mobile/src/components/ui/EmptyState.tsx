import { StyleSheet, Text, View } from "react-native";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

/**
 * `compact` is for an empty state that sits INSIDE a titled Card (or right
 * above its own retry button): the Card already pads by spacing.xl and its
 * title by spacing.lg, so the full-screen padding here stacked on top of that
 * doubled the heading->content gap against the sibling cards. Full-screen
 * empties keep the generous padding.
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
    <View style={[styles.wrap, compact ? styles.wrapCompact : null]}>
      <Text style={styles.title}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", paddingVertical: spacing.xxl * 1.5, gap: spacing.sm },
  wrapCompact: { paddingVertical: spacing.lg },
  title: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, ...RTL_TEXT, textAlign: "center" },
  hint: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, textAlign: "center" },
});
