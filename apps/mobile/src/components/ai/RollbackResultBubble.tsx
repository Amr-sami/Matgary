import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * RollbackResultBubble — F10.0 success result after a confirmed rollback.
 *
 * Shows the restored state with a success chip so the user has visual
 * confirmation the undo actually landed. Server verifies post-write; this
 * component ONLY renders the trusted restoredState.
 */
export function RollbackResultBubble({ block }: { block: ai.RollbackResultBlock }) {
  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>↩</Text>
        </View>
        <Text numberOfLines={2} style={styles.title}>
          {block.title}
        </Text>
      </View>
      <Text style={styles.message}>{block.message}</Text>

      {block.affectedFields.length > 0 ? (
        <View style={styles.fields}>
          {block.affectedFields.map((f) => {
            const restored = (block.restoredState as Record<string, unknown>)[f];
            return (
              <View key={f} style={styles.row}>
                <Text style={styles.fieldName}>{f}</Text>
                <Text style={styles.fieldValue}>{formatValue(restored)}</Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "✓" : "✗";
  return String(v);
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.successLight,
    borderWidth: 1,
    borderColor: colors.successStrong,
    gap: spacing.sm,
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
    backgroundColor: colors.successStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontFamily: fonts.bold,
    fontSize: 14,
    color: colors.onAccent,
  },
  title: {
    ...RTL_TEXT,
    flex: 1,
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.successStrong,
  },
  message: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.text,
  },
  fields: {
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.xs,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  fieldName: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.textSecondary,
  },
  fieldValue: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 13,
    color: colors.successStrong,
    fontVariant: ["tabular-nums"],
  },
});
