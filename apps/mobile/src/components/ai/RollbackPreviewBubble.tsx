import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * RollbackPreviewBubble — F10.0 server-assembled preview that accompanies a
 * ConfirmationBlock. Shows the before / after / current values so the user
 * can see exactly what will be restored before tapping Confirm.
 *
 * `destructive` tightens the border + background to the danger palette so
 * the user treats the action with extra care (e.g. customer.create → delete).
 */
export function RollbackPreviewBubble({ block }: { block: ai.RollbackPreviewBlock }) {
  const dangerous = block.destructive;
  return (
    <View style={[styles.card, dangerous ? styles.cardDanger : styles.cardNeutral]}>
      <Text style={[styles.title, dangerous ? styles.titleDanger : null]}>
        {block.title}
      </Text>
      <Text style={styles.description}>{block.description}</Text>

      {block.affectedFields.length > 0 ? (
        <View style={styles.fields}>
          {block.affectedFields.map((f) => {
            const before = (block.beforeState as Record<string, unknown>)[f];
            const after = (block.afterState as Record<string, unknown>)[f];
            return (
              <View key={f} style={styles.fieldRow}>
                <Text numberOfLines={1} style={styles.fieldName}>
                  {f}
                </Text>
                <View style={styles.fieldValues}>
                  <Text style={styles.valueAfter}>{formatValue(after)}</Text>
                  <Text style={styles.arrow}>→</Text>
                  <Text style={styles.valueBefore}>{formatValue(before)}</Text>
                </View>
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
    borderWidth: 1,
    gap: spacing.sm,
  },
  cardNeutral: {
    backgroundColor: colors.card,
    borderColor: colors.accent,
  },
  cardDanger: {
    backgroundColor: colors.dangerLight,
    borderColor: colors.danger,
  },
  title: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.text,
  },
  titleDanger: { color: colors.danger },
  description: {
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
  fieldRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
  },
  fieldName: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.textSecondary,
    flex: 1,
  },
  fieldValues: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  valueAfter: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.textSecondary,
    textDecorationLine: "line-through",
    fontVariant: ["tabular-nums"],
  },
  arrow: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  valueBefore: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 13,
    color: colors.accent,
    fontVariant: ["tabular-nums"],
  },
});
