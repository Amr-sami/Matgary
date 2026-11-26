import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * KPI card row — up to 6 cards, wraps naturally. Tone colours the value
 * (green for up / red for down / default for neutral or unset).
 */
export function KpiBubble({ block }: { block: ai.KpiBlock }) {
  return (
    <View style={styles.wrap}>
      {block.title ? <Text style={styles.title}>{block.title}</Text> : null}
      <View style={styles.grid}>
        {block.items.map((item, i) => {
          const toneStyle =
            item.tone === "up"
              ? styles.valueUp
              : item.tone === "down"
                ? styles.valueDown
                : item.trendPct != null
                  ? item.trendPct >= 0
                    ? styles.valueUp
                    : styles.valueDown
                  : null;
          return (
            <View key={i} style={styles.card}>
              <Text numberOfLines={2} style={styles.label}>
                {item.label}
              </Text>
              <Text numberOfLines={1} style={[styles.value, toneStyle]}>
                {item.value}
              </Text>
              {item.trendPct != null ? (
                <Text
                  style={[
                    styles.trend,
                    item.trendPct >= 0 ? styles.valueUp : styles.valueDown,
                  ]}
                >
                  {item.trendPct >= 0 ? "▲ " : "▼ "}
                  {Math.abs(item.trendPct).toFixed(1)}%
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  title: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 13,
    color: colors.textSecondary,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  card: {
    flexGrow: 1,
    flexBasis: "47%",
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  label: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
  },
  value: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 18,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  trend: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  valueUp: { color: colors.successStrong },
  valueDown: { color: colors.danger },
});
