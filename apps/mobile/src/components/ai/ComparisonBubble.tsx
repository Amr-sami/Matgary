import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * ComparisonBubble — side-by-side matrix of 2-4 entities.
 *
 * Server built every value from the live database (see buildProductComparison).
 * Mobile only formats + highlights winners. An attribute with no winner
 * (brand / sku) shows all cells equally; one with a winnerEntityId picks out
 * the best cell.
 */
export function ComparisonBubble({ block }: { block: ai.ComparisonBlock }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{block.title}</Text>
      {block.description ? (
        <Text style={styles.description}>{block.description}</Text>
      ) : null}

      <View style={styles.headerRow}>
        <View style={styles.rowLabelCell} />
        {block.entities.map((e) => (
          <View key={e.entityId} style={styles.entityHeaderCell}>
            <Text numberOfLines={2} style={styles.entityName}>
              {e.label}
            </Text>
            {e.subtitle ? (
              <Text numberOfLines={1} style={styles.entitySubtitle}>
                {e.subtitle}
              </Text>
            ) : null}
          </View>
        ))}
      </View>

      {block.attributes.map((attr) => (
        <View key={attr.label} style={styles.dataRow}>
          <View style={styles.rowLabelCell}>
            <Text numberOfLines={1} style={styles.attrLabel}>
              {attr.label}
            </Text>
          </View>
          {block.entities.map((e) => {
            const raw = block.values[attr.label]?.[e.entityId];
            const isWinner = attr.winnerEntityId === e.entityId;
            const display = formatCell(raw, attr.format);
            return (
              <View
                key={e.entityId}
                style={[styles.valueCell, isWinner && styles.valueCellWinner]}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.valueText, isWinner && styles.valueTextWinner]}
                >
                  {display}
                </Text>
                {isWinner ? (
                  <Text style={styles.winnerBadge}>
                    {t("mobile.insights.ai.comparison.winner")}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function formatCell(
  raw: string | number | null | undefined,
  format: ai.ComparisonAttribute["format"],
): string {
  if (raw === null || raw === undefined || raw === "") {
    return t("mobile.insights.ai.comparison.unavailable");
  }
  if (format === "money" && typeof raw === "number") return money(raw);
  if (format === "percent" && typeof raw === "number") return `${raw.toFixed(1)}%`;
  return String(raw);
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  title: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.text,
  },
  description: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
  },
  headerRow: {
    flexDirection: "row",
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  rowLabelCell: {
    flexBasis: 72,
    flexGrow: 0,
    justifyContent: "center",
  },
  entityHeaderCell: {
    flex: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.accentLight,
    gap: 2,
  },
  entityName: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.text,
  },
  entitySubtitle: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 10,
    color: colors.textSecondary,
  },
  dataRow: {
    flexDirection: "row",
    gap: spacing.xs,
    alignItems: "stretch",
    minHeight: 36,
  },
  attrLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.textSecondary,
  },
  valueCell: {
    flex: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: "center",
    gap: 2,
  },
  valueCellWinner: {
    borderColor: colors.accent,
    backgroundColor: colors.accentLight,
  },
  valueText: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  valueTextWinner: {
    fontFamily: fonts.bold,
    color: colors.accent,
  },
  winnerBadge: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 9,
    color: colors.accent,
  },
});
