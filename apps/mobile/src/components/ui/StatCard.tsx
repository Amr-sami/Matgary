import type { ComponentType } from "react";
import { StyleSheet, Text, View } from "react-native";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

type PhosphorIcon = ComponentType<{ size?: number; color?: string; weight?: never }>;

interface StatCardProps {
  title: string;
  value: string | number;
  icon: PhosphorIcon;
  color?: "accent" | "success" | "danger";
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
export function StatCard({ title, value, icon: Icon, color = "accent" }: StatCardProps) {
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {/* A money figure must never split from its currency — this is the
              defect the web shipped and had to be measured to fix. */}
          <Text style={styles.value} numberOfLines={1}>
            {value}
          </Text>
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
});
