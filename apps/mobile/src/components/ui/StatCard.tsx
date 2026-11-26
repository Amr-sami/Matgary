import type { ComponentType } from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import { TrendDownIcon as TrendDown } from "phosphor-react-native/src/icons/TrendDown";
import { TrendUpIcon as TrendUp } from "phosphor-react-native/src/icons/TrendUp";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

type PhosphorIcon = ComponentType<{ size?: number; color?: string; weight?: never }>;

interface StatCardProps {
  title: string;
  value: string | number;
  icon: PhosphorIcon;
  color?: "accent" | "success" | "danger" | "warning";
  /**
   * Wash the whole card in the colour's light tint (bg + border), the way the
   * web's InventorySummary flags a nonzero low-stock / out-of-stock count.
   * Opt-in: a danger-coloured KPI that is merely "spend" (Insights → total
   * discounts) must stay white, so the caller decides when the count warrants it.
   */
  tint?: boolean;
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
  tint = false,
  subtitle,
  trendPercent,
}: StatCardProps) {
  const up = (trendPercent ?? 0) >= 0;
  const wash = tint ? TINTS[color] : undefined;
  return (
    <View style={[styles.card, wash]}>
      <View style={styles.row}>
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          {/* Value (+ trend, caption) sits directly under the title, as in
              the design capture (mobile-fold/app__insights.png: "89" hugs
              its label). An earlier pass pinned this group to the card's
              bottom so values would share a baseline when a neighbour's
              title wrapped — but cards stretch to the TALLEST sibling, and
              a trend pill or a two-line caption made that sibling taller,
              which dropped "114" ~33pt below its own label and left a hole
              under it. A wrapped title now offsets its value by one line,
              exactly as the web does; nothing ever floats to the bottom. */}
          <View style={styles.figures}>
            {/* A money figure must never split from its currency — this is the
                defect the web shipped and had to be measured to fix. */}
            <Text
              style={styles.value}
              numberOfLines={1}
              // Shrink rather than ellipsize: "EGP 575,2…" is a wrong number,
              // and English currency is wider than Arabic in the same 2-up card.
              adjustsFontSizeToFit
              minimumFontScale={0.7}
            >
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
  // flexShrink + minWidth:0 let a long title wrap instead of pushing the icon
  // out of the card. Content-sized: the figures stay glued to the title.
  text: { flexShrink: 1, minWidth: 0 },
  figures: { marginTop: 4 },
  title: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  value: {
    fontFamily: fonts.bold,
    fontSize: 20,
    color: colors.text,
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
  // The run is all bidi-neutral ("+", digits, "%"), so with no strong
  // character its base direction falls back to the DEVICE locale: an Arabic
  // phone renders "+157.7%" as "157.7%+" (the web capture shows exactly that
  // defect). Pinning it LTR keeps the sign first in both app languages.
  trendText: {
    ...RTL_TEXT,
    writingDirection: "ltr",
    fontFamily: fonts.medium,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  // #27AE60 measures 2.87:1 on white and fails AA as text; successStrong is
  // 4.72:1. The saturated green stays for fills and icons only.
  trendTextUp: { color: colors.successStrong },
  trendTextDown: { color: colors.danger },
});

/**
 * Per-colour card wash for `tint`. Mirrors the web's InventorySummary
 * (`bg-orange-50 border-orange-200` / `bg-danger-light/30 border-danger/20`):
 * the light token for the ground, the strong colour at 20% for the border so
 * it still reads as an edge against the wash. Accent and success have no
 * tinted state on the web, so they stay white.
 */
const TINTS: Record<NonNullable<StatCardProps["color"]>, ViewStyle | undefined> = {
  accent: undefined,
  success: undefined,
  warning: { backgroundColor: colors.warningLight, borderColor: `${colors.warning}33` },
  danger: { backgroundColor: colors.dangerLight, borderColor: `${colors.danger}33` },
};
