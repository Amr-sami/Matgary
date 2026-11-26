import { StyleSheet, Text, View } from "react-native";
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "phosphor-react-native/src/icons/ArrowCounterClockwise";
import { CoinsIcon as Coins } from "phosphor-react-native/src/icons/Coins";
import { ShoppingCartIcon as ShoppingCart } from "phosphor-react-native/src/icons/ShoppingCart";
import { WalletIcon as Wallet } from "phosphor-react-native/src/icons/Wallet";

import { t } from "@/i18n";
import { Card } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/StatCard";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Structured report body — matches the home-dashboard rhythm (2×2 StatCard
 * grid + follow-up cards) so a report feels like a focused dashboard for a
 * closed period rather than a foreign document.
 *
 * Layout:
 *   1) 2×2 KPI grid — same primitive the dashboard uses (Revenue, Sales,
 *      Net profit, Returns). The Revenue tile carries the period-over-period
 *      trend arrow via StatCard's own `trendPercent` prop.
 *   2) Trend card — day-by-day revenue sparkline when the window has at least
 *      two data points. Pure-View bars, no SVG dependency.
 *   3) Top products — ranked rows with an accent rank bubble and a revenue chip.
 *   4) Category breakdown — proportional accent bars.
 *   5) Comparison — the three one-line reconciliation facts.
 */

export interface ReportOverview {
  metrics: {
    currentRevenue: number;
    lastRevenue: number;
    revenueGrowth: number;
    totalRevenue: number;
    totalCostOfGoods: number;
    totalExpenses: number;
    grossProfit: number;
    netProfit: number;
    totalDiscounts: number;
    discountPercent: number;
    totalSales: number;
    totalReturns: number;
  };
  trendData?: Array<{ date: string; revenue: number; count: number }>;
  topProducts: Array<{
    id: string;
    name: string;
    brand: string | null;
    qty: number;
    revenue: number;
  }>;
  categoryChartData: Array<{ name: string; value: number }>;
}

export function ReportBody({ overview }: { overview: ReportOverview }) {
  const m = overview.metrics;
  const top = overview.topProducts.slice(0, 5);
  const cats = overview.categoryChartData.slice(0, 5);
  const trend = overview.trendData ?? [];
  const showTrendPct = m.lastRevenue > 0;

  return (
    <View style={styles.stack}>
      {/* 2×2 KPI grid — the exact dashboard rhythm. */}
      <View style={styles.grid}>
        <View style={styles.gridRow}>
          <StatCard
            title={t("mobile.reports.kpi.revenue")}
            value={money(m.totalRevenue)}
            icon={Coins}
            color="success"
            trendPercent={showTrendPct ? m.revenueGrowth : null}
          />
          <StatCard
            title={t("mobile.reports.kpi.sales")}
            value={String(m.totalSales)}
            icon={ShoppingCart}
            color="accent"
          />
        </View>
        <View style={styles.gridRow}>
          <StatCard
            title={t("mobile.reports.kpi.netProfit")}
            value={money(m.netProfit)}
            icon={Coins}
            color={m.netProfit >= 0 ? "success" : "danger"}
          />
          <StatCard
            title={t("mobile.reports.kpi.returns")}
            value={String(m.totalReturns)}
            icon={ArrowCounterClockwise}
            color="danger"
          />
        </View>
        <View style={styles.gridRow}>
          <StatCard
            title={t("mobile.reports.kpi.expenses")}
            value={money(m.totalExpenses)}
            icon={Wallet}
            color="danger"
          />
          <StatCard
            title={t("mobile.reports.kpi.discounts")}
            value={money(m.totalDiscounts)}
            icon={Coins}
            color="warning"
            subtitle={
              m.totalRevenue > 0
                ? t("mobile.reports.kpi.discountsPct", { pct: m.discountPercent.toFixed(1) })
                : undefined
            }
          />
        </View>
      </View>

      {/* Trend */}
      {trend.length >= 2 ? (
        <Card title={t("mobile.reports.sections.trend")}>
          <Sparkline data={trend.map((d) => d.revenue)} />
        </Card>
      ) : null}

      {/* Top products */}
      <Card title={t("mobile.reports.sections.topProducts")}>
        {top.length === 0 ? (
          <Text style={styles.empty}>{t("mobile.reports.empty.noSales")}</Text>
        ) : (
          top.map((p, idx) => (
            <View
              key={p.id}
              style={[styles.productRow, idx === top.length - 1 && styles.productRowLast]}
            >
              <View style={styles.productRank}>
                <Text style={styles.productRankText}>{idx + 1}</Text>
              </View>
              <View style={styles.productBody}>
                <Text numberOfLines={1} style={styles.productName}>
                  {p.name}
                </Text>
                <Text numberOfLines={1} style={styles.productMeta}>
                  {p.brand ? `${p.brand} · ` : ""}
                  {t("mobile.reports.productQty", { n: p.qty })}
                </Text>
              </View>
              <View style={styles.productMoney}>
                <Text style={styles.productMoneyText}>{money(p.revenue)}</Text>
              </View>
            </View>
          ))
        )}
      </Card>

      {/* Category breakdown */}
      {cats.length > 0 ? (
        <Card title={t("mobile.reports.sections.byCategory")}>
          {cats.map((c, i) => {
            const total = cats.reduce((sum, x) => sum + x.value, 0) || 1;
            const pct = (c.value / total) * 100;
            return (
              <View key={`${c.name}-${i}`} style={styles.catRow}>
                <View style={styles.catHeader}>
                  <Text style={styles.catName}>{c.name}</Text>
                  <Text style={styles.catValue}>{money(c.value)}</Text>
                </View>
                <View style={styles.catTrack}>
                  <View
                    style={[styles.catFill, { width: `${pct.toFixed(1)}%` as `${number}%` }]}
                  />
                </View>
              </View>
            );
          })}
        </Card>
      ) : null}

      {/* Comparison */}
      <Card title={t("mobile.reports.sections.comparison")}>
        <ComparisonRow label={t("mobile.reports.kpi.lastPeriod")} value={money(m.lastRevenue)} />
        <ComparisonRow label={t("mobile.reports.kpi.grossProfit")} value={money(m.grossProfit)} />
        <ComparisonRow
          label={t("mobile.reports.kpi.cogs")}
          value={money(m.totalCostOfGoods)}
          last
        />
      </Card>
    </View>
  );
}

function ComparisonRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.compRow, last && styles.compRowLast]}>
      <Text style={styles.compLabel}>{label}</Text>
      <Text style={styles.compValue}>{value}</Text>
    </View>
  );
}

/**
 * Pure-View sparkline — accent-filled bars on the card background. Zero
 * days still render a 3pt baseline so the strip reads as a shape, not gaps.
 */
function Sparkline({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  return (
    <View style={styles.sparkRow}>
      {data.map((v, i) => {
        const pct = v === 0 ? 4 : Math.max(10, Math.round((v / max) * 100));
        return (
          <View key={i} style={styles.sparkCol}>
            <View style={[styles.sparkBar, { height: `${pct}%` as `${number}%` }]} />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.md },

  // Mirrors app/(app)/index.tsx :: styles.grid/gridRow exactly so a report
  // reads as a dashboard scoped to a closed period.
  grid: { gap: spacing.sm },
  gridRow: { flexDirection: "row", gap: spacing.sm },

  // Sparkline
  sparkRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 4,
    height: 56,
  },
  sparkCol: { flex: 1, height: "100%", justifyContent: "flex-end" },
  sparkBar: { backgroundColor: colors.accent, borderRadius: 3 },

  // Products
  empty: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  productRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  productRowLast: { borderBottomWidth: 0, paddingBottom: 0 },
  productRank: {
    width: 30,
    height: 30,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  productRankText: {
    fontFamily: fonts.bold,
    fontSize: 13,
    color: colors.accent,
    lineHeight: 30,
    textAlign: "center",
    includeFontPadding: false,
    marginTop: -1,
  },
  productBody: { flex: 1, minWidth: 0, gap: 2 },
  productName: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text, ...RTL_TEXT },
  productMeta: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  productMoney: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: colors.neutralTint,
    flexShrink: 0,
  },
  productMoneyText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },

  // Categories
  catRow: { paddingVertical: spacing.xs, gap: spacing.xs },
  catHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  catName: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text, ...RTL_TEXT },
  catValue: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  catTrack: { height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: "hidden" },
  catFill: { height: "100%", backgroundColor: colors.accent, borderRadius: 3 },

  // Comparison
  compRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  compRowLast: { borderBottomWidth: 0, paddingBottom: 0 },
  compLabel: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  compValue: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
});
