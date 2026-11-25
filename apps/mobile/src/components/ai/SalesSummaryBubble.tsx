import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * SalesSummaryBubble — period revenue headline with optional trend arrow.
 *
 * Every number is computed server-side in buildSalesSummary. Trend is a
 * decimal fraction (0.12 = +12%); null → prior period unavailable.
 */
export function SalesSummaryBubble({ block }: { block: ai.SalesSummaryBlock }) {
  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.titleCol}>
          <Text style={styles.title}>{block.title}</Text>
          <Text style={styles.period}>{block.periodLabel}</Text>
        </View>
        {block.scope ? <Text style={styles.scope}>{block.scope}</Text> : null}
      </View>

      <View style={styles.primaryStat}>
        <Text style={styles.primaryLabel}>
          {t("mobile.insights.ai.salesSummary.revenue")}
        </Text>
        <Text style={styles.primaryValue}>{money(block.revenue)}</Text>
        {typeof block.revenueTrendPct === "number" ? (
          <Text
            style={[
              styles.trend,
              block.revenueTrendPct >= 0 ? styles.trendUp : styles.trendDown,
            ]}
          >
            {block.revenueTrendPct >= 0 ? "▲ " : "▼ "}
            {Math.abs(block.revenueTrendPct * 100).toFixed(1)}%
            <Text style={styles.trendSuffix}>
              {" "}
              {t("mobile.insights.ai.salesSummary.vsPrevious")}
            </Text>
          </Text>
        ) : (
          <Text style={styles.trendMissing}>
            {t("mobile.insights.ai.salesSummary.noTrend")}
          </Text>
        )}
      </View>

      <View style={styles.statGrid}>
        <StatCell
          label={t("mobile.insights.ai.salesSummary.orders")}
          value={block.orders.toLocaleString("en-US")}
        />
        <StatCell
          label={t("mobile.insights.ai.salesSummary.averageOrderValue")}
          value={money(block.averageOrderValue)}
        />
      </View>

      {block.topLine ? (
        <View style={styles.topLineRow}>
          <Text numberOfLines={1} style={styles.topLineLabel}>
            {block.topLine.label}
          </Text>
          <Text numberOfLines={1} style={styles.topLineValue}>
            {block.topLine.value}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statCell}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
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
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  titleCol: { flex: 1, gap: 2 },
  title: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.text,
  },
  period: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.textSecondary,
  },
  scope: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textSecondary,
  },
  primaryStat: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.accentLight,
    gap: 2,
  },
  primaryLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textSecondary,
  },
  primaryValue: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 24,
    color: colors.accent,
    fontVariant: ["tabular-nums"],
  },
  trend: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 12,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
  trendSuffix: {
    fontFamily: fonts.regular,
    color: colors.textSecondary,
  },
  trendUp: { color: colors.successStrong },
  trendDown: { color: colors.danger },
  trendMissing: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: 2,
  },
  statGrid: { flexDirection: "row", gap: spacing.sm },
  statCell: {
    flex: 1,
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
  topLineRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  topLineLabel: {
    ...RTL_TEXT,
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.textSecondary,
  },
  topLineValue: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
});
