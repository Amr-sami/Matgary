// Operating expenses by group — horizontal bar card for the mobile Overview.
// Uses plain View widths (no SVG) so RTL mirroring is free and the layout
// adapts to label length without SVG text-metrics guesswork. Sorted largest
// first, capped at 6 rows to keep the card from dominating the screen.

import { StyleSheet, Text, View } from "react-native";

import { Card } from "@/components/ui/Card";
import { money } from "@/lib/format";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

interface Group {
  nameAr: string;
  nameEn: string;
  total: number;
}

export function OpexByGroupBars({ groups }: { groups: Group[] }) {
  const sorted = [...groups]
    .filter((g) => g.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);
  const max = Math.max(1, ...sorted.map((g) => g.total));

  if (sorted.length === 0) {
    return (
      <Card>
        <Text style={styles.title}>{t("mobile.financials.charts.opexByGroup")}</Text>
        <Text style={styles.empty}>{t("mobile.financials.charts.noData")}</Text>
      </Card>
    );
  }

  return (
    <Card>
      <Text style={styles.title}>{t("mobile.financials.charts.opexByGroup")}</Text>
      <View style={{ gap: spacing.sm, marginTop: spacing.xs }}>
        {sorted.map((g) => {
          const pct = Math.max(2, Math.round((g.total / max) * 100));
          return (
            <View key={g.nameEn + g.total} style={styles.row}>
              <View style={styles.rowHeader}>
                <Text style={styles.label} numberOfLines={1}>
                  {g.nameAr || g.nameEn}
                </Text>
                <Text style={styles.amount}>{money(g.total)}</Text>
              </View>
              <View style={styles.track}>
                <View
                  style={[styles.fill, { width: `${pct}%` }]}
                />
              </View>
            </View>
          );
        })}
      </View>
    </Card>
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
  row: { gap: 4 },
  rowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  label: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.text,
    flex: 1,
  },
  amount: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.neutralTint,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    backgroundColor: colors.accent,
    borderRadius: 3,
  },
});
