import { useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { CurrencyDollar, Percent, ShoppingCart, TrendUp } from "phosphor-react-native";

import { api } from "@/api/client";
import { TrendChart } from "@/components/charts/TrendChart";
import { Screen } from "@/components/layout/Screen";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { Segmented } from "@/components/ui/Segmented";
import { StatCard } from "@/components/ui/StatCard";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

interface Overview {
  metrics: {
    currentRevenue: number;
    lastRevenue: number;
    revenueGrowth: number;
    netProfit: number;
    totalDiscounts: number;
    discountPercent: number;
    totalSales: number;
    totalReturns: number;
  };
  trendData: { date: string; revenue: number; count: number }[];
}

type Range = "all" | "today" | "yesterday" | "7d" | "30d";

const RANGES: { key: Range; label: string }[] = [
  { key: "all", label: "الكل" },
  { key: "today", label: "اليوم" },
  { key: "yesterday", label: "أمس" },
  { key: "7d", label: "آخر 7 أيام" },
  { key: "30d", label: "آخر 30 يوم" },
];

/**
 * Port of app__insights.png (the نظرة عامة tab).
 *
 * The KPI grid is `grid-cols-2` on phones, not `sm:grid-cols-2` — Tailwind's
 * `sm` is 640px, so a 390px phone never reached it and fell to ONE column,
 * putting 502px of stat cards above the first chart. That was measured and
 * fixed on the web (session-record §1g); two-up is the correct layout here.
 */
export default function InsightsScreen() {
  const [tab, setTab] = useState<"overview" | "deep" | "staff">("overview");
  const [range, setRange] = useState<Range>("all");

  const overview = useQuery({
    queryKey: ["insights-overview"],
    queryFn: () => api.request<Overview>("/api/insights/overview"),
  });

  const m = overview.data?.metrics;
  const trend = overview.data?.trendData ?? [];

  const trendStats = useMemo(() => {
    if (!trend.length) return null;
    const total = trend.reduce((s, d) => s + d.revenue, 0);
    const peak = trend.reduce((a, b) => (b.revenue > a.revenue ? b : a), trend[0]!);
    return { total, avg: total / trend.length, peak };
  }, [trend]);

  return (
    <Screen
      onRefresh={() => void overview.refetch()}
      refreshing={overview.isRefetching}
    >
      <Segmented
        value={tab}
        onChange={setTab}
        items={[
          { key: "overview", label: "نظرة عامة" },
          { key: "deep", label: "تحليل معمّق" },
          { key: "staff", label: "الموظفون" },
        ]}
      />

      <View style={styles.chipRow}>
        {RANGES.map((r) => (
          <Chip
            key={r.key}
            label={r.label}
            active={range === r.key}
            onPress={() => setRange(r.key)}
          />
        ))}
      </View>

      {tab !== "overview" ? (
        <Card>
          <Text style={styles.soon}>
            {tab === "deep" ? "التحليل المعمّق" : "أداء الموظفين"} — قريباً
          </Text>
        </Card>
      ) : overview.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : !m ? (
        <Card>
          <Text style={styles.soon}>تعذّر تحميل الإحصائيات</Text>
        </Card>
      ) : (
        <>
          <View style={styles.grid}>
            <View style={styles.gridRow}>
              <StatCard
                title="مبيعات الشهر الحالي"
                value={money(m.currentRevenue)}
                icon={CurrencyDollar}
                color="accent"
                trendPercent={m.revenueGrowth}
                subtitle="عن الشهر السابق"
              />
              <StatCard
                title="إجمالي المبيعات"
                value={String(m.totalSales)}
                icon={ShoppingCart}
                color="accent"
                subtitle="عملية بيع"
              />
            </View>
            <View style={styles.gridRow}>
              <StatCard
                title="صافي الربح"
                value={money(m.netProfit)}
                icon={TrendUp}
                color="success"
                subtitle="بعد المصاريف والتكلفة"
              />
              <StatCard
                title="إجمالي الخصومات"
                value={money(m.totalDiscounts)}
                icon={Percent}
                color="danger"
                subtitle={`${m.discountPercent.toFixed(1)}% من القيمة`}
              />
            </View>
          </View>

          {trendStats ? (
            <Card title="اتجاه المبيعات (آخر 30 يوم)">
              <View style={styles.trendStats}>
                <TrendStat label="الإجمالي" value={money(trendStats.total)} />
                <TrendStat label="المتوسط" value={money(trendStats.avg)} />
                <TrendStat
                  label="الذروة"
                  value={money(trendStats.peak.revenue)}
                  caption={trendStats.peak.date}
                />
              </View>
              <TrendChart data={trend} />
            </Card>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function TrendStat({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption?: string;
}) {
  return (
    <View style={styles.trendStat}>
      <Text style={styles.trendLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.trendValue}>
        {value}
      </Text>
      {caption ? <Text style={styles.trendCaption}>{caption}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  grid: { gap: spacing.lg },
  gridRow: { flexDirection: "row", gap: spacing.lg },
  soon: { fontFamily: fonts.medium, fontSize: 15, color: colors.textSecondary, ...RTL_TEXT },
  trendStats: {
    flexDirection: "row",
    gap: spacing.md,
    paddingBottom: spacing.lg,
    marginBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  trendStat: { flex: 1, gap: 2 },
  trendLabel: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  trendValue: {
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.text,
    fontVariant: ["tabular-nums"],
    ...RTL_TEXT,
  },
  trendCaption: { fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary, ...RTL_TEXT },
});
