import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  BarChart,
  LineChart,
  PieChart,
  type barDataItem,
  type lineDataItem,
  type pieDataItem,
} from "react-native-gifted-charts";

import type { ai } from "@matgary/api-client";

import { compact, money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Chart block renderer — dispatches to the right gifted-charts primitive.
 *
 * Mapping:
 *   line   → <LineChart>  (areaChart off)
 *   area   → <LineChart>  (areaChart on)
 *   bar    → <BarChart>  horizontal if the series has only one key
 *   pie    → <PieChart>
 *   donut  → <PieChart donut>
 *
 * The agent only ever sends ONE series for pie/donut (slices of a whole) and
 * may send multiple series for line/area/bar (we render the FIRST one; wave 4
 * will add overlaid series). Keeping the renderer narrow for now matches the
 * data tools we have and prevents the model from asking for a 5-series chart
 * that would be unreadable in a chat bubble.
 */

const PALETTE = [
  colors.accent,
  "#F59E0B",
  "#10B981",
  "#EF4444",
  "#8B5CF6",
  "#06B6D4",
];

export function ChartBubble({ block }: { block: ai.ChartBlock }) {
  const first = block.series[0];
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{block.title}</Text>
      {block.description ? <Text style={styles.desc}>{block.description}</Text> : null}
      <View style={styles.card}>
        <ChartBody block={block} seriesIndex={0} />
      </View>
      {first && block.series.length > 1 ? (
        <Text style={styles.footnote}>
          {block.series.map((s) => s.label).join(" · ")}
        </Text>
      ) : (
        <Text style={styles.footnote}>{first?.label ?? ""}</Text>
      )}
    </View>
  );
}

function ChartBody({ block, seriesIndex }: { block: ai.ChartBlock; seriesIndex: number }) {
  const series = block.series[seriesIndex];
  if (!series) return <Text style={styles.empty}>—</Text>;

  if (block.chartType === "pie" || block.chartType === "donut") {
    const pieData = useMemo<pieDataItem[]>(() => {
      return block.data.map((row, i) => {
        const value = toNumber(row[series.dataKey]);
        return {
          value,
          color: PALETTE[i % PALETTE.length],
          text: shortLabel(row[block.xKey ?? series.dataKey]),
        };
      });
    }, [block, series]);
    if (pieData.length === 0) return <Text style={styles.empty}>—</Text>;
    return (
      <PieChart
        data={pieData}
        donut={block.chartType === "donut"}
        radius={90}
        innerRadius={block.chartType === "donut" ? 55 : 0}
        textColor={colors.text}
        textSize={11}
        showText
      />
    );
  }

  if (block.chartType === "bar") {
    const barData = useMemo<barDataItem[]>(() => {
      return block.data.map((row, i) => ({
        value: toNumber(row[series.dataKey]),
        label: shortLabel(row[block.xKey ?? ""]),
        frontColor: series.color ?? PALETTE[i % PALETTE.length],
      }));
    }, [block, series]);
    const maxVal = Math.max(1, ...barData.map((d) => d.value ?? 0));
    return (
      <BarChart
        data={barData}
        barWidth={22}
        spacing={14}
        hideRules
        yAxisThickness={0}
        xAxisThickness={0}
        yAxisTextStyle={{ color: colors.textSecondary, fontSize: 10 }}
        xAxisLabelTextStyle={{ color: colors.textSecondary, fontSize: 10 }}
        noOfSections={4}
        maxValue={niceCeil(maxVal)}
        formatYLabel={(l) => compact(Number(l))}
      />
    );
  }

  // line | area
  const lineData = useMemo<lineDataItem[]>(() => {
    return block.data.map((row) => ({
      value: toNumber(row[series.dataKey]),
      label: shortLabel(row[block.xKey ?? ""]),
    }));
  }, [block, series]);
  const maxVal = Math.max(1, ...lineData.map((d) => d.value ?? 0));
  return (
    <LineChart
      data={lineData}
      areaChart={block.chartType === "area"}
      color={series.color ?? colors.accent}
      thickness={2}
      startFillColor={series.color ?? colors.accent}
      endFillColor={series.color ?? colors.accent}
      startOpacity={0.25}
      endOpacity={0.02}
      hideDataPoints={lineData.length > 20}
      hideRules
      yAxisThickness={0}
      xAxisThickness={0}
      yAxisTextStyle={{ color: colors.textSecondary, fontSize: 10 }}
      xAxisLabelTextStyle={{ color: colors.textSecondary, fontSize: 10 }}
      noOfSections={4}
      maxValue={niceCeil(maxVal)}
      formatYLabel={(l) => compact(Number(l))}
      initialSpacing={10}
      spacing={Math.max(18, Math.floor(260 / Math.max(1, lineData.length)))}
    />
  );
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function shortLabel(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return s.length > 10 ? s.slice(0, 10) + "…" : s;
}

/** Round up to a "nice" axis maximum so the top line isn't 9237.6. */
function niceCeil(n: number): number {
  if (n <= 10) return Math.ceil(n);
  const magnitude = Math.pow(10, Math.floor(Math.log10(n)));
  return Math.ceil(n / magnitude) * magnitude;
}

// Explicit no-op reference to keep `money` import tree-shake-safe for future
// wiring (axis labels per currency land in wave 4).
void money;

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  title: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  desc: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
  },
  footnote: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textSecondary,
    textAlign: "center",
  },
  empty: { ...RTL_TEXT, color: colors.textSecondary, padding: spacing.md },
});
