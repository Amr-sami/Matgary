import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * ImportConflictBubble — F10.1 partial-rollback outcome. Shown when some
 * rows of an import couldn't be reversed (concurrent change / dependency /
 * write failure). Counts come from the server-side rollback engine.
 */
export function ImportConflictBubble({ block }: { block: ai.ImportConflictBlock }) {
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
      {block.reasons.length > 0 ? (
        <View style={styles.reasons}>
          {block.reasons.slice(0, 6).map((r) => (
            <Text key={r.operationId} style={styles.reason}>
              {r.code}: {r.message}
            </Text>
          ))}
        </View>
      ) : null}
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
    gap: spacing.sm,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  badge: {
    width: 28,
    height: 28,
    borderRadius: radius.full,
    backgroundColor: colors.warning,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontFamily: fonts.bold, fontSize: 16, color: colors.onAccent },
  title: { ...RTL_TEXT, flex: 1, fontFamily: fonts.bold, fontSize: 15, color: colors.warningStrong },
  message: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.text, lineHeight: 19 },
  reasons: { gap: 2, marginTop: spacing.xs },
  reason: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary },
});
