import { useMemo } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/api/client";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { countLabel, money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

import type { InsightsRange } from "./DeepTab";

/**
 * Port of apps/web/components/insights/StaffPerformance.tsx — the "الموظفون"
 * tab. Same `/api/insights/staff-performance` endpoint; when the range is
 * "all" the API silently defaults to the last 30 days, so a subtitle says so —
 * only then: for every other range the selected chip sits 40–60pt above the
 * card and already names the window.
 */

interface StaffStat {
  userId: string;
  name: string;
  salesCount: number;
  salesRevenue: number;
  returnsCount: number;
}

interface StaffResponse {
  data: StaffStat[];
  range: { from: string; to: string };
}

const UNATTRIBUTED = "__unattributed__";

export function StaffTab({ range, from, to }: { range: InsightsRange; from?: string; to?: string }) {
  const hasWindow = Boolean(from && to);
  const q = useQuery({
    queryKey: ["insights-staff", range, from ?? null, to ?? null],
    queryFn: () =>
      api.request<StaffResponse>("/api/insights/staff-performance", {
        query: hasWindow ? { from, to } : undefined,
      }),
  });

  const model = useMemo(() => {
    const data = q.data?.data ?? [];
    const known = data.filter((d) => d.userId !== UNATTRIBUTED);
    const unattributed = data.find((d) => d.userId === UNATTRIBUTED);
    return {
      known,
      unattributed,
      totalRevenue: data.reduce((s, d) => s + d.salesRevenue, 0),
      totalOps: data.reduce((s, d) => s + d.salesCount, 0),
      max: Math.max(1, ...data.map((d) => d.salesRevenue)),
    };
  }, [q.data]);

  if (q.isLoading) return <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.xl }} />;
  if (!q.data) {
    return (
      <Card>
        <Text style={styles.muted}>{t("mobile.insights.loadFailed")}</Text>
        <Button
          label={t("app.common.retry")}
          variant="outline"
          loading={q.isFetching}
          onPress={() => void q.refetch()}
          style={styles.retry}
        />
      </Card>
    );
  }

  const empty = model.known.length === 0 && !model.unattributed;

  return (
    <>
      <Card title={t("app.insights.staff.title")}>
        {range === "all" ? <Text style={styles.subtitle}>{t("app.insights.staff.rangeFallback")}</Text> : null}
        {empty ? (
          <EmptyState title={t("app.insights.staff.empty.title")} hint={t("app.insights.staff.empty.subtitle")} />
        ) : (
          <>
            <View style={styles.statRow}>
              <Stat label={t("app.insights.staff.summary.active")} value={String(model.known.length)} />
              <View style={styles.statDivider} />
              <Stat label={t("app.insights.staff.summary.totalRevenue")} value={money(model.totalRevenue)} />
              <View style={styles.statDivider} />
              <Stat label={t("app.insights.staff.summary.ops")} value={String(model.totalOps)} />
            </View>

            <Text style={styles.sectionTitle}>{t("app.insights.staff.leaderboard")}</Text>
            <View style={styles.list}>
              {model.known.map((s, i) => (
                <View key={s.userId} style={styles.row}>
                  <View style={styles.rowHead}>
                    <View style={[styles.rank, i === 0 && styles.rankTop]}>
                      <Text style={[styles.rankText, i === 0 && styles.rankTextTop]}>{i + 1}</Text>
                    </View>
                    <Text numberOfLines={1} style={styles.name}>
                      {s.name || t("app.insights.staff.unattributed.title")}
                    </Text>
                    <Text style={styles.value}>{money(s.salesRevenue)}</Text>
                  </View>
                  <View style={styles.track}>
                    <View style={[styles.fill, { width: `${(s.salesRevenue / model.max) * 100}%` }]} />
                  </View>
                  <View style={styles.metaRow}>
                    <Text style={styles.meta}>{countLabel("app.insights.staff.metric.ops", s.salesCount)}</Text>
                    {s.returnsCount > 0 ? (
                      <>
                        <Text style={styles.meta}>{"·"}</Text>
                        <Text style={[styles.meta, styles.metaDanger]}>
                          {countLabel("app.insights.staff.metric.returns", s.returnsCount)}
                        </Text>
                      </>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          </>
        )}
      </Card>

      {model.unattributed && model.unattributed.salesCount > 0 ? (
        <Card style={styles.notice}>
          <Text style={styles.noticeTitle}>{t("app.insights.staff.unattributed.title")}</Text>
          <Text style={styles.noticeBody}>
            {t("app.insights.staff.unattributed.body", {
              count: model.unattributed.salesCount,
              amount: money(model.unattributed.salesRevenue),
            })}
          </Text>
        </Card>
      ) : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  muted: { fontFamily: fonts.medium, fontSize: 15, color: colors.textSecondary, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, marginBottom: spacing.lg, ...RTL_TEXT },
  sectionTitle: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text, marginBottom: spacing.sm, ...RTL_TEXT },

  // Same 3-up row as DeepTab's compare card and the Customers KPIs — three
  // stats never wrap, so nothing is orphaned under the divider. A ~100px
  // column (390px phone) holds a 7-digit money total at 15px; the labels are
  // kept short enough in both locales to stay on one line so the values align.
  statRow: {
    flexDirection: "row",
    gap: spacing.md,
    paddingBottom: spacing.lg,
    marginBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  stat: { flex: 1, gap: 2 },
  // Same hairline DeepTab's compare card and the overview trend card put between their three stats.
  statDivider: { width: 1, alignSelf: "stretch", backgroundColor: colors.border },
  statLabel: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  statValue: { fontFamily: fonts.bold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"], ...RTL_TEXT },

  list: { gap: spacing.md },
  row: { gap: spacing.xs },
  rowHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  rank: {
    width: 24,
    height: 24,
    borderRadius: radius.full,
    backgroundColor: colors.neutralTint,
    alignItems: "center",
    justifyContent: "center",
  },
  rankTop: { backgroundColor: colors.accent },
  rankText: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 12, color: colors.neutralText, fontVariant: ["tabular-nums"] },
  rankTextTop: { color: colors.card },
  name: { flex: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  value: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"] },
  track: { height: 6, borderRadius: radius.full, backgroundColor: colors.neutralTint, overflow: "hidden" },
  fill: { height: "100%", borderRadius: radius.full, backgroundColor: colors.accent },
  metaRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  metaDanger: { color: colors.danger },
  retry: { alignSelf: "flex-start", marginTop: spacing.md },

  notice: { backgroundColor: colors.warningLight, borderColor: colors.warningTint },
  noticeTitle: { fontFamily: fonts.semibold, fontSize: 14, color: colors.warningStrong, marginBottom: spacing.xs, ...RTL_TEXT },
  noticeBody: { fontFamily: fonts.regular, fontSize: 13, color: colors.text, lineHeight: 20, ...RTL_TEXT },
});
