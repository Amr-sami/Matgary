import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * BulkPreviewBubble — F10.3 preview of a filtered bulk price update.
 * Numbers come from the deterministic server computation; mobile only renders.
 */
export function BulkPreviewBubble({ block }: { block: ai.BulkPreviewBlock }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{block.title}</Text>
      <Text style={styles.description}>{block.description}</Text>

      <View style={styles.statRow}>
        <Stat label="Eligible" value={block.totalEligible} tone="accent" />
        <Stat label="Matched" value={block.totalMatched} tone="neutral" />
        {block.skippedOverCap > 0 ? (
          <Stat label="Over cap" value={block.skippedOverCap} tone="warn" />
        ) : null}
      </View>

      <View style={styles.deltaRow}>
        <Text style={styles.deltaLabel}>Net change</Text>
        <Text
          style={[
            styles.deltaValue,
            block.totalPriceDelta >= 0 ? styles.deltaUp : styles.deltaDown,
          ]}
        >
          {block.totalPriceDelta >= 0 ? "+" : ""}
          {money(block.totalPriceDelta)}
        </Text>
      </View>

      {block.sampleChanges.length > 0 ? (
        <View style={styles.sampleWrap}>
          <Text style={styles.sampleHeader}>Sample ({block.sampleChanges.length})</Text>
          {block.sampleChanges.map((c) => (
            <View key={c.productId} style={styles.sampleRow}>
              <Text numberOfLines={1} style={styles.sampleName}>
                {c.name}
              </Text>
              <View style={styles.sampleValues}>
                <Text style={styles.sampleBefore}>{money(c.beforePrice)}</Text>
                <Text style={styles.arrow}>→</Text>
                <Text style={styles.sampleAfter}>{money(c.afterPrice)}</Text>
              </View>
            </View>
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
  tone: "accent" | "neutral" | "warn";
}) {
  const toneStyle =
    tone === "accent" ? styles.toneAccent : tone === "warn" ? styles.toneWarn : styles.toneNeutral;
  return (
    <View style={[styles.stat, toneStyle]}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.accent,
    gap: spacing.sm,
  },
  title: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  description: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.text },
  statRow: { flexDirection: "row", gap: spacing.xs, marginTop: spacing.xs },
  stat: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    alignItems: "center",
    gap: 2,
  },
  statValue: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 18, color: colors.text, fontVariant: ["tabular-nums"] },
  statLabel: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 10, color: colors.textSecondary, textTransform: "uppercase" },
  toneAccent: { backgroundColor: colors.accentLight },
  toneNeutral: { backgroundColor: colors.neutralTint },
  toneWarn: { backgroundColor: colors.warningLight },
  deltaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.neutralTint,
  },
  deltaLabel: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary },
  deltaValue: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 16, fontVariant: ["tabular-nums"] },
  deltaUp: { color: colors.successStrong },
  deltaDown: { color: colors.danger },
  sampleWrap: {
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.xs,
  },
  sampleHeader: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 11,
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sampleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm },
  sampleName: { ...RTL_TEXT, flex: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.text },
  sampleValues: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  sampleBefore: { fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, textDecorationLine: "line-through", fontVariant: ["tabular-nums"] },
  arrow: { fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary },
  sampleAfter: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent, fontVariant: ["tabular-nums"] },
});
