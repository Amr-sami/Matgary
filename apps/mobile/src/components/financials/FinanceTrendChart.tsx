// Revenue vs Expenses area + optional Net Profit line for the Financials
// Overview. Built on react-native-svg (same stack as insights/TrendChart) so
// we don't carry victory-native for one chart. The net-profit line is drawn
// only when the server returned `seesProfit: true` — the view_profit
// permission is already enforced server-side via field nulling.

import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Line, Path, Text as SvgText } from "react-native-svg";

import { Card } from "@/components/ui/Card";
import { compact } from "@/lib/format";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";
import type { TrendPoint } from "@/hooks/useFinance";

interface Props {
  points: TrendPoint[];
  seesProfit: boolean;
  height?: number;
}

export function FinanceTrendChart({ points, seesProfit, height = 180 }: Props) {
  const [width, setWidth] = useState(0);
  const revenue = points.map((p) => p.netSales);
  const expenses = points.map((p) => p.operatingExpenses);
  const profit = seesProfit ? points.map((p) => p.netProfit ?? 0) : [];

  // Shared Y scale across all series so revenue dwarfing expenses doesn't
  // flatten the expense line to zero (and vice versa). Negative net profit
  // is drawn by symmetric reflection around the baseline.
  const maxPositive = Math.max(
    ...revenue,
    ...expenses,
    ...profit.map((v) => Math.max(0, v)),
    1,
  );
  const minNegative = Math.min(
    0,
    ...profit.map((v) => Math.min(0, v)),
  );
  const magnitude = Math.max(maxPositive, Math.abs(minNegative));

  if (width === 0 || points.length === 0) {
    return (
      <Card>
        <Text style={styles.title}>{t("mobile.financials.charts.revenueVsExpenses")}</Text>
        <View style={{ height }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)} />
      </Card>
    );
  }

  if (points.length < 2) {
    return (
      <Card>
        <Text style={styles.title}>{t("mobile.financials.charts.revenueVsExpenses")}</Text>
        <Text style={styles.empty}>{t("mobile.financials.charts.noData")}</Text>
      </Card>
    );
  }

  const ticks = [0.25, 0.5, 0.75, 1].map((f) => ({
    v: magnitude * f,
    label: compact(magnitude * f),
  }));
  const padLeft = Math.max(44, 12 + Math.max(...ticks.map((tick) => tick.label.length)) * 6);
  const padBottom = 18;
  const padTop = 8;
  const plotW = Math.max(width - padLeft - 8, 1);
  const plotH = Math.max(height - padBottom - padTop, 1);

  const x = (i: number) => padLeft + (i / (points.length - 1)) * plotW;
  const yPositive = (v: number) =>
    padTop + plotH - (Math.max(0, v) / (magnitude || 1)) * plotH;

  const pathFor = (series: number[]) =>
    series
      .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yPositive(v).toFixed(1)}`)
      .join(" ");

  const revenueArea = `${pathFor(revenue)} L${x(points.length - 1).toFixed(1)},${(padTop + plotH).toFixed(1)} L${padLeft},${(padTop + plotH).toFixed(1)} Z`;

  return (
    <Card>
      <Text style={styles.title}>{t("mobile.financials.charts.revenueVsExpenses")}</Text>
      <View style={styles.wrap} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <Svg width={width} height={height}>
          {ticks.map((tick) => (
            <Line
              key={tick.v}
              x1={padLeft}
              y1={yPositive(tick.v)}
              x2={width - 8}
              y2={yPositive(tick.v)}
              stroke={colors.border}
              strokeWidth={1}
              strokeDasharray="4 4"
            />
          ))}
          {ticks.map((tick) => (
            <SvgText
              key={`l-${tick.v}`}
              x={padLeft - 6}
              y={yPositive(tick.v) + 4}
              fontSize={10}
              fill={colors.textSecondary}
              fontFamily={fonts.regular}
              textAnchor="end"
            >
              {tick.label}
            </SvgText>
          ))}
          <Path d={revenueArea} fill={colors.accent} fillOpacity={0.08} />
          <Path d={pathFor(revenue)} stroke={colors.accent} strokeWidth={2} fill="none" />
          <Path d={pathFor(expenses)} stroke={colors.danger} strokeWidth={2} fill="none" />
          {seesProfit ? (
            <Path d={pathFor(profit)} stroke={colors.success} strokeWidth={2} fill="none" />
          ) : null}
        </Svg>
      </View>
      <View style={styles.legend}>
        <LegendDot color={colors.accent} label={t("app.financials.kpi.netSales")} />
        <LegendDot color={colors.danger} label={t("app.financials.kpi.operatingExpenses")} />
        {seesProfit ? (
          <LegendDot color={colors.success} label={t("app.financials.kpi.netProfit")} />
        ) : null}
      </View>
    </Card>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  title: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  empty: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: "center",
    paddingVertical: spacing.lg,
  },
  wrap: { marginTop: spacing.xs },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  dot: { width: 10, height: 10, borderRadius: 5 },
  legendLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textSecondary,
  },
});
