import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * InventorySummaryBubble — totals + urgent items.
 *
 * Every number is computed server-side in buildInventorySummary from the
 * same catalog repo the mobile insights screens use.
 */
export function InventorySummaryBubble({ block }: { block: ai.InventorySummaryBlock }) {
  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>{block.title}</Text>
        {block.scope ? <Text style={styles.scope}>{block.scope}</Text> : null}
      </View>

      <View style={styles.statGrid}>
        <StatCell
          label={t("mobile.insights.ai.inventorySummary.total")}
          value={block.totalProducts.toLocaleString("en-US")}
          tone="neutral"
        />
        <StatCell
          label={t("mobile.insights.ai.inventorySummary.lowStock")}
          value={block.lowStockCount.toLocaleString("en-US")}
          tone={block.lowStockCount > 0 ? "warn" : "neutral"}
        />
        <StatCell
          label={t("mobile.insights.ai.inventorySummary.outOfStock")}
          value={block.outOfStockCount.toLocaleString("en-US")}
          tone={block.outOfStockCount > 0 ? "danger" : "neutral"}
        />
        {block.stockValue != null ? (
          <StatCell
            label={
              block.stockValueBasis === "cost"
                ? t("mobile.insights.ai.inventorySummary.stockValueCost")
                : t("mobile.insights.ai.inventorySummary.stockValueRetail")
            }
            value={money(block.stockValue)}
            tone="neutral"
          />
        ) : null}
      </View>

      {block.highlights && block.highlights.length > 0 ? (
        <View style={styles.highlightSection}>
          <Text style={styles.highlightTitle}>
            {t("mobile.insights.ai.inventorySummary.urgent")}
          </Text>
          <View style={styles.highlightList}>
            {block.highlights.map((h) => (
              <View key={h.productId} style={styles.highlightRow}>
                <Text numberOfLines={1} style={styles.highlightName}>
                  {h.name}
                </Text>
                <View
                  style={[
                    styles.highlightChip,
                    h.state === "out_of_stock"
                      ? styles.highlightChipDanger
                      : styles.highlightChipWarn,
                  ]}
                >
                  <Text
                    style={[
                      styles.highlightChipText,
                      h.state === "out_of_stock"
                        ? styles.highlightChipTextDanger
                        : styles.highlightChipTextWarn,
                    ]}
                  >
                    {h.state === "out_of_stock"
                      ? t("mobile.insights.ai.productCard.outOfStock")
                      : t("mobile.insights.ai.productCard.lowStock", { n: h.quantity })}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function StatCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "neutral" | "warn" | "danger";
}) {
  const toneStyle =
    tone === "danger" ? styles.statValueDanger : tone === "warn" ? styles.statValueWarn : null;
  return (
    <View style={styles.statCell}>
      <Text numberOfLines={1} style={styles.statLabel}>
        {label}
      </Text>
      <Text numberOfLines={1} style={[styles.statValue, toneStyle]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: spacing.sm,
  },
  title: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.text,
  },
  scope: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textSecondary,
  },
  statGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  statCell: {
    flexGrow: 1,
    flexBasis: "47%",
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
  },
  statLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textSecondary,
  },
  statValue: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 16,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  statValueWarn: { color: colors.warningStrong },
  statValueDanger: { color: colors.danger },
  highlightSection: { gap: spacing.xs, marginTop: spacing.xs },
  highlightTitle: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.textSecondary,
  },
  highlightList: { gap: spacing.xs },
  highlightRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  highlightName: {
    ...RTL_TEXT,
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.text,
  },
  highlightChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  highlightChipWarn: { backgroundColor: colors.warningTint },
  highlightChipDanger: { backgroundColor: colors.dangerLight },
  highlightChipText: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 11,
  },
  highlightChipTextWarn: { color: colors.warningStrong },
  highlightChipTextDanger: { color: colors.danger },
});
