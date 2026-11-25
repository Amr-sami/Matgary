import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * RollbackConflictBubble — F10.0 safe refusal when an undo is blocked.
 *
 * `kind_detail` is a stable enum so the mobile client can route to a help
 * hint or deep-link to the conflicting record in a future wave. Today it
 * drives the icon + copy only.
 */
export function RollbackConflictBubble({ block }: { block: ai.RollbackConflictBlock }) {
  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>!</Text>
        </View>
        <Text numberOfLines={2} style={styles.title}>
          {block.title}
        </Text>
      </View>
      <Text style={styles.message}>{block.message}</Text>
      <Text style={styles.detail}>{block.kind_detail}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.warningLight,
    borderWidth: 1,
    borderColor: colors.warning,
    gap: spacing.xs,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  badge: {
    width: 28,
    height: 28,
    borderRadius: radius.full,
    backgroundColor: colors.warning,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontFamily: fonts.bold,
    fontSize: 16,
    color: colors.onAccent,
  },
  title: {
    ...RTL_TEXT,
    flex: 1,
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.warningStrong,
  },
  message: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.text,
  },
  detail: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 10,
    letterSpacing: 0.5,
    color: colors.textSecondary,
    textTransform: "uppercase",
    marginTop: spacing.xs,
  },
});
