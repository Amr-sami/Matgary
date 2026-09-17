import type { ComponentType } from "react";
import { StyleSheet, Text, View } from "react-native";
import { TrendDown, TrendUp } from "phosphor-react-native";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

type PhosphorIcon = ComponentType<{ size?: number; color?: string; weight?: never }>;

interface StatCardProps {
  title: string;
  value: string | number;
  icon: PhosphorIcon;
  color?: "accent" | "success" | "danger";
  /** Caption under the value, e.g. "عملية بيع". */
  subtitle?: string;
  /**
   * Percentage delta, rendered as its own pill ABOVE the caption. The web put
   * the caption inside the badge, which made the badge wrap; splitting them is
   * what fixed it (session-record §1b).
   */
  trendPercent?: number | null;
}

/**
 * Port of apps/web/components/dashboard/StatCard.tsx.
 *
 * Layout is `items-start justify-between` — label + value in a column, icon
 * pushed to the far edge. Under RTL that puts the icon on the LEFT and the text
 * on the RIGHT, which is what the design capture shows.
 *
 * The web dropped the filled icon chip: the icon is bare, in the brand colour.
 */
export function StatCard({
  title,
  value,
  icon: Icon,
  color = "accent",
  subtitle,
  trendPercent,
}: StatCardProps) {
  const up = (trendPercent ?? 0) >= 0;
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          {/* A money figure must never split from its currency — this is the
              defect the web shipped and had to be measured to fix. */}
          <Text style={styles.value} numberOfLines={1}>
            {value}
          </Text>

          {trendPercent !== null && trendPercent !== undefined ? (
            <View style={[styles.trend, up ? styles.trendUp : styles.trendDown]}>
              {up ? (
                <TrendUp size={13} color={colors.successStrong} />
              ) : (
                <TrendDown size={13} color={colors.danger} />
              )}
              <Text
                numberOfLines={1}
                style={[styles.trendText, up ? styles.trendTextUp : styles.trendTextDown]}
              >
                {up ? "+" : ""}
                {trendPercent.toFixed(1)}%
              </Text>
            </View>
          ) : null}

          {subtitle ? (
            <Text style={styles.subtitle} numberOfLines={2}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <Icon size={24} color={colors[color]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...elevation.card,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  text: { flexShrink: 1, minWidth: 0 },
  title: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  value: {
    fontFamily: fonts.bold,
    fontSize: 20,
    color: colors.text,
    marginTop: 4,
    fontVariant: ["tabular-nums"],
    ...RTL_TEXT,
  },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 4,
    ...RTL_TEXT,
  },
  trend: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    flexShrink: 0,
  },
  trendUp: { backgroundColor: colors.successLight },
  trendDown: { backgroundColor: colors.dangerLight },
  // #27AE60 measures 2.87:1 on white and fails AA as text; successStrong is
  // 4.72:1. The saturated green stays for fills and icons only.
  trendText: { fontFamily: fonts.medium, fontSize: 12, fontVariant: ["tabular-nums"] },
  trendTextUp: { color: colors.successStrong },
  trendTextDown: { color: colors.danger },
});
