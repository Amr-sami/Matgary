import { useEffect, useMemo, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CoinsIcon as Coins } from "phosphor-react-native/src/icons/Coins";
import { PercentIcon as Percent } from "phosphor-react-native/src/icons/Percent";
import { ShoppingCartIcon as ShoppingCart } from "phosphor-react-native/src/icons/ShoppingCart";
import { TrendUpIcon as TrendUp } from "phosphor-react-native/src/icons/TrendUp";

import { api } from "@/api/client";
import { TrendChart } from "@/components/charts/TrendChart";
import { DeepTab } from "@/components/insights/DeepTab";
import { StaffTab } from "@/components/insights/StaffTab";
import { Screen } from "@/components/layout/Screen";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { StatCard } from "@/components/ui/StatCard";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
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
type Tab = "overview" | "deep" | "staff";
const isRange = (v: unknown): v is Range =>
  v === "all" || v === "today" || v === "yesterday" || v === "7d" || v === "30d";
const isTab = (v: unknown): v is Tab => v === "overview" || v === "deep" || v === "staff";

const RANGES = (): { key: Range; label: string }[] => ([
  { key: "all", label: t("app.common.all") },
  { key: "today", label: t("app.dateRange.today") },
  { key: "yesterday", label: t("app.dateRange.yesterday") },
  { key: "7d", label: t("app.dateRange.7d") },
  { key: "30d", label: t("app.dateRange.30d") },
]);

/**
 * The API labels each trend day with date-fns `format(d, "MMM dd")` — English
 * month abbreviations whatever the tenant's locale. The peak caption is the one
 * place that string is shown as-is, so it is parsed back here and re-labelled
 * from the dictionary ("Sep 14" → "14 سبتمبر"). Anything that does not match
 * the shape is shown untouched rather than hidden.
 */
const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function localizeTrendDate(raw: string): string {
  const m = /^([A-Za-z]{3}) (\d{1,2})$/.exec(raw.trim());
  if (!m) return raw;
  const idx = MONTH_KEYS.indexOf(m[1]!.toLowerCase());
  if (idx < 0) return raw;
  return t("mobile.insights.peakDate", {
    day: String(Number(m[2])),
    month: t(`mobile.insights.month.${MONTH_KEYS[idx]}`),
  });
}

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
  // `insights?tab=deep|staff` deep-links straight to a tab (notifications, dev probes).
  const params = useLocalSearchParams<{ tab?: string; range?: string; report?: string; branchId?: string }>();
  const [tab, setTab] = useState<Tab>(isTab(params.tab) ? params.tab : "overview");
  const [range, setRange] = useState<Range>(isRange(params.range) ? params.range : "all");
  // Tab screens stay mounted, so a later deep link only changes the params.
  useEffect(() => { if (isTab(params.tab)) setTab(params.tab); }, [params.tab]);
  useEffect(() => { if (isRange(params.range)) setRange(params.range); }, [params.range]);

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

  // Pull-to-refresh must reach whichever tab is showing. The overview query
  // is the only one owned here; the Deep and Staff tabs own theirs, so they
  // are invalidated by key prefix (mounted ones refetch now, unmounted ones
  // refetch on their next mount). A local flag drives the spinner so that a
  // tab's FIRST load does not also spin the RefreshControl.
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        overview.refetch(),
        qc.invalidateQueries({ queryKey: ["insights-staff"] }),
        qc.invalidateQueries({ queryKey: ["insights-deep"] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

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
      title={t("app.insights.title")}
      onRefresh={() => void onRefresh()}
      refreshing={refreshing}
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
          <RangeChip
            key={r.key}
            label={r.label}
            active={range === r.key}
            onPress={() => setRange(r.key)}
          />
        ))}
      </View>

      {tab === "deep" ? (
        <DeepTab
          range={range}
          from={window?.from}
          to={window?.to}
          initialReport={params.report}
          initialBranchId={params.branchId}
        />
      ) : tab === "staff" ? (
        <StaffTab range={range} from={window?.from} to={window?.to} />
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
                icon={Coins}
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
            <Card>
              {/* Title + subtitle are laid out here rather than via Card's
                  `title` prop, which has no second line; the web card shows
                  "متوسط يومي · ذروة الفترة · إجمالي" directly under the heading. */}
              <View style={styles.trendHeader}>
                <Text style={styles.trendTitle}>
                  {t("mobile.insights.trendTitle", { range: RANGES().find((r) => r.key === range)?.label ?? "" })}
                </Text>
                <Text style={styles.trendSubtitle}>{t("app.insights.trend.subtitle")}</Text>
              </View>
              <View style={styles.trendStats}>
                <TrendStat label={t("app.insights.trend.stat.total")} value={money(trendStats.total)} />
                <View style={styles.trendDivider} />
                <TrendStat label={t("app.insights.trend.stat.avg")} value={money(trendStats.avg)} />
                <View style={styles.trendDivider} />
                <TrendStat
                  label={t("app.insights.trend.stat.peak")}
                  value={money(trendStats.peak.revenue)}
                  caption={localizeTrendDate(trendStats.peak.date)}
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

/**
 * A compact sibling of ui/Chip for the five period presets. The shared Chip's
 * 14px label + 16px side padding measures ~420px for الكل / اليوم / أمس /
 * آخر 7 أيام / آخر 30 يوم and wrapped the last chip onto a second row on a
 * 390px phone; the design keeps all five on one line. Same states and roles
 * as Chip, tighter padding, and the chips grow to share the row. Row order
 * comes from the root direction — no reversing here.
 */
function RangeChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.rangeChip,
        active ? styles.rangeChipActive : styles.rangeChipInactive,
        pressed && !active && styles.rangeChipPressed,
      ]}
    >
      <Text
        numberOfLines={1}
        style={[styles.rangeChipText, active ? styles.rangeChipTextActive : styles.rangeChipTextInactive]}
      >
        {label}
      </Text>
    </Pressable>
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
  chipRow: { flexDirection: "row", gap: spacing.sm },
  rangeChip: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  rangeChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  rangeChipInactive: { backgroundColor: colors.bg, borderColor: colors.border },
  rangeChipPressed: { backgroundColor: colors.accentLight },
  rangeChipText: { fontFamily: fonts.medium, fontSize: 13, ...RTL_TEXT },
  rangeChipTextActive: { color: colors.card }, // white on accent; the ground token is the only white
  rangeChipTextInactive: { color: colors.text },
  grid: { gap: spacing.lg },
  gridRow: { flexDirection: "row", gap: spacing.lg },
  soon: { fontFamily: fonts.medium, fontSize: 15, color: colors.textSecondary, ...RTL_TEXT },
  trendHeader: { gap: 2, marginBottom: spacing.lg },
  trendTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, ...RTL_TEXT },
  trendSubtitle: { fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary, ...RTL_TEXT },
  trendStats: {
    flexDirection: "row",
    gap: spacing.md,
    paddingBottom: spacing.lg,
    marginBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  trendStat: { flex: 1, gap: 2 },
  trendDivider: { width: 1, alignSelf: "stretch", backgroundColor: colors.border },
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
