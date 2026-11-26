import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * ImportResultBubble — F10.1 import outcome. Counts come from the actual
 * post-write verification; failures (if any) surface with their row-level
 * reasons. The component never fakes success.
 */
export function ImportResultBubble({ block }: { block: ai.ImportResultBlock }) {
  const anyFailure = block.failed > 0;
  const tone = anyFailure ? styles.cardMixed : styles.cardSuccess;
  return (
    <View style={[styles.card, tone]}>
      <View style={styles.headerRow}>
        <View style={[styles.badge, anyFailure ? styles.badgeMixed : styles.badgeSuccess]}>
          <Text style={styles.badgeText}>{anyFailure ? "!" : "✓"}</Text>
        </View>
        <Text numberOfLines={2} style={styles.title}>
          {block.title}
        </Text>
      </View>
      <Text style={styles.message}>{block.message}</Text>

      <View style={styles.statRow}>
        <Stat label="Created" value={block.created} />
        <Stat label="Updated" value={block.updated} />
        <Stat label="Skipped" value={block.skipped} />
        <Stat label="Failed" value={block.failed} tone={block.failed > 0 ? "danger" : "muted"} />
      </View>

      {block.failures.length > 0 ? (
        <View style={styles.failuresWrap}>
          {block.failures.map((f) => (
            <Text key={f.rowIndex} style={styles.failure}>
              Row {f.rowIndex}: {f.reason}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "danger" | "muted";
}) {
  return (
    <View style={styles.stat}>
      <Text
        style={[
          styles.statValue,
          tone === "danger" ? styles.valueDanger : null,
          tone === "muted" ? styles.valueMuted : null,
        ]}
      >
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
  },
  cardSuccess: {
    backgroundColor: colors.successLight,
    borderColor: colors.successStrong,
  },
  cardMixed: {
    backgroundColor: colors.warningLight,
    borderColor: colors.warning,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  badge: {
    width: 28,
    height: 28,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeSuccess: { backgroundColor: colors.successStrong },
  badgeMixed: { backgroundColor: colors.warning },
  badgeText: { fontFamily: fonts.bold, fontSize: 14, color: colors.onAccent },
  title: { ...RTL_TEXT, flex: 1, fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  message: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.text },
  statRow: { flexDirection: "row", gap: spacing.xs, marginTop: spacing.xs },
  stat: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: "center",
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
  },
  statValue: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 18,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  valueDanger: { color: colors.danger },
  valueMuted: { color: colors.textSecondary },
  statLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 10,
    color: colors.textSecondary,
    textTransform: "uppercase",
  },
  failuresWrap: { gap: 2, marginTop: spacing.xs },
  failure: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 11, color: colors.danger },
});
