import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * BulkResultBubble — F10.3 outcome of a bulk price update. Counts are
 * accurate (updated + skipped + failed = total); the server never claims
 * success when any row conflicted.
 */
export function BulkResultBubble({ block }: { block: ai.BulkResultBlock }) {
  const mixed = block.skipped > 0 || block.failed > 0;
  return (
    <View style={[styles.card, mixed ? styles.cardMixed : styles.cardSuccess]}>
      <View style={styles.headerRow}>
        <View style={[styles.badge, mixed ? styles.badgeMixed : styles.badgeSuccess]}>
          <Text style={styles.badgeText}>{mixed ? "!" : "✓"}</Text>
        </View>
        <Text numberOfLines={2} style={styles.title}>
          {block.title}
        </Text>
      </View>
      <Text style={styles.message}>{block.message}</Text>
      <View style={styles.statRow}>
        <Stat label="Updated" value={block.updated} />
        <Stat label="Skipped" value={block.skipped} tone={block.skipped > 0 ? "warn" : "muted"} />
        <Stat label="Failed" value={block.failed} tone={block.failed > 0 ? "danger" : "muted"} />
      </View>
      {block.reasons.length > 0 ? (
        <View style={styles.reasons}>
          {block.reasons.slice(0, 6).map((r) => (
            <Text key={r.productId} style={styles.reason}>
              {r.code}: {r.message}
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
  tone?: "warn" | "danger" | "muted";
}) {
  return (
    <View style={styles.stat}>
      <Text
        style={[
          styles.statValue,
          tone === "warn" ? styles.valueWarn : null,
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
  card: { padding: spacing.md, borderRadius: radius.lg, borderWidth: 1, gap: spacing.sm },
  cardSuccess: { backgroundColor: colors.successLight, borderColor: colors.successStrong },
  cardMixed: { backgroundColor: colors.warningLight, borderColor: colors.warning },
  headerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  badge: { width: 28, height: 28, borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
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
  statValue: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 18, color: colors.text, fontVariant: ["tabular-nums"] },
  valueWarn: { color: colors.warningStrong },
  valueDanger: { color: colors.danger },
  valueMuted: { color: colors.textSecondary },
  statLabel: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 10, color: colors.textSecondary, textTransform: "uppercase" },
  reasons: { gap: 2, marginTop: spacing.xs },
  reason: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 11, color: colors.danger },
});
