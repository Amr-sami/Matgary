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
import { t } from "@/i18n";

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

const RANGES = (): { key: Range; label: string }[] => ([
  { key: "all", label: t("app.common.all") },
  { key: "today", label: t("app.dateRange.today") },
  { key: "yesterday", label: t("app.dateRange.yesterday") },
  { key: "7d", label: t("app.dateRange.7d") },
  { key: "30d", label: t("app.dateRange.30d") },
]);

/**
 * Port of the preset → window logic in apps/web/app/insights/page.tsx, so the
 * phone and the desktop show the same figures for "آخر 7 أيام". The API needs
 * both bounds together and as ISO strings with an offset; "الكل" sends neither.
 */
function rangeWindow(key: Range): { from: string; to: string } | null {
  if (key === "all") return null;
  const now = new Date();
  const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const endOfDay = (d: Date) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
  let from: Date;
  let to: Date = endOfDay(now);
  switch (key) {
    case "today":
      from = startOfDay(now);
      break;
    case "yesterday": {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      from = startOfDay(y); to = endOfDay(y);
      break;
    }
    case "7d": {
      const f = new Date(now); f.setDate(f.getDate() - 6);
      from = startOfDay(f);
      break;
    }
    case "30d": {
      const f = new Date(now); f.setDate(f.getDate() - 29);
      from = startOfDay(f);
      break;
    }
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

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

  // The range is part of the KEY, not just the params: a chip tap must
  // refetch, not serve the previous range's numbers from cache. The first
  // build set `range` state and never read it — the chips did nothing.
  const window = rangeWindow(range);
  const overview = useQuery({
    queryKey: ["insights-overview", range],
    queryFn: () =>
      api.request<Overview>("/api/insights/overview", {
        query: window ? { from: window.from, to: window.to } : undefined,
      }),
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
          { key: "overview", label: t("app.insights.tabs.overview") },
          { key: "deep", label: t("app.insights.tabs.deep") },
          { key: "staff", label: t("app.insights.tabs.staff") },
        ]}
      />

      <View style={styles.chipRow}>
        {RANGES().map((r) => (
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
            {t("mobile.insights.comingSoon", { section: tab === "deep" ? t("mobile.insights.deepDive") : t("app.insights.staff.title") })}
          </Text>
        </Card>
      ) : overview.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : !m ? (
        <Card>
          <Text style={styles.soon}>{t("mobile.insights.loadFailed")}</Text>
        </Card>
      ) : (
        <>
          <View style={styles.grid}>
            <View style={styles.gridRow}>
              <StatCard
                title={t("app.insights.headline.monthCurrent")}
                value={money(m.currentRevenue)}
                icon={CurrencyDollar}
                color="accent"
                trendPercent={m.revenueGrowth}
                subtitle={t("app.insights.comparison.all")}
              />
              <StatCard
                title={t("app.insights.kpi.totalSales")}
                value={String(m.totalSales)}
                icon={ShoppingCart}
                color="accent"
                subtitle={t("app.insights.kpi.totalSalesSubtitle")}
              />
            </View>
            <View style={styles.gridRow}>
              <StatCard
                title={t("app.insights.kpi.netProfit")}
                value={money(m.netProfit)}
                icon={TrendUp}
                color="success"
                subtitle={t("app.insights.kpi.netProfitSubtitle")}
              />
              <StatCard
                title={t("app.insights.kpi.totalDiscounts")}
                value={money(m.totalDiscounts)}
                icon={Percent}
                color="danger"
                subtitle={t("mobile.insights.ofValue", { pct: m.discountPercent.toFixed(1) })}
              />
            </View>
          </View>

          {trendStats ? (
            <Card title={t("mobile.insights.trendTitle", { range: RANGES().find((r) => r.key === range)?.label ?? "" })}>
              <View style={styles.trendStats}>
                <TrendStat label={t("app.insights.trend.stat.total")} value={money(trendStats.total)} />
                <TrendStat label={t("app.insights.trend.stat.avg")} value={money(trendStats.avg)} />
                <TrendStat
                  label={t("app.insights.trend.stat.peak")}
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
