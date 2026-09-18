import { StyleSheet, Text, View } from "react-native";
import { CheckCircleIcon as CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { WarningIcon as Warning } from "phosphor-react-native/src/icons/Warning";

import { Badge } from "@/components/ui/Badge";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";
import type { LowStockItem } from "@matgary/api-client";

/**
 * Port of apps/web/components/dashboard/LowStockAlert.tsx.
 *
 * Each row is a TINTED panel, not a plain list item: out-of-stock on
 * danger-light at ~50% with a hairline danger border, low-stock on the orange
 * surface. The warning glyph sits at the far edge opposite the text, which
 * under RTL puts it on the left — matching app__dashboard.png.
 */
export function StockAlerts({ items }: { items: LowStockItem[] }) {
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>{t("app.dashboard.lowStock.title")}</Text>

      {items.length === 0 ? (
        <View style={styles.allGood}>
          <CheckCircle size={20} color={colors.success} />
          <Text style={styles.allGoodText}>{t("app.dashboard.lowStock.allGood")}</Text>
        </View>
      ) : (
        <View style={styles.list}>
          {items.map((item) => {
            const out = item.quantity === 0;
            return (
              <View
                key={item.id}
                style={[styles.row, out ? styles.rowOut : styles.rowLow]}
              >
                <View style={styles.rowText}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <View style={styles.meta}>
                    <Badge
                      label={out ? t("app.dashboard.lowStock.outOfStock") : t("app.dashboard.lowStock.pieces", { n: item.quantity })}
                      variant={out ? "outofstock" : "lowstock"}
                    />
                    {item.brand ? (
                      <Text style={styles.brand} numberOfLines={1}>
                        {item.brand}
                      </Text>
                    ) : null}
                  </View>
                </View>
                <Warning size={16} color={out ? colors.danger : colors.warning} />
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    ...elevation.card,
  },
  heading: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.text,
    marginBottom: spacing.lg,
    ...RTL_TEXT,
  },
  list: { gap: spacing.md },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  // bg-danger-light/50 + border-danger/10
  rowOut: { backgroundColor: "#FEF4F4", borderColor: "rgba(192,57,43,0.1)" },
  // bg-orange-50 + border-orange-100
  rowLow: { backgroundColor: colors.warningLight, borderColor: colors.warningTint },
  rowText: { flexShrink: 1, minWidth: 0, gap: 6 },
  name: { fontFamily: fonts.medium, fontSize: 14, color: colors.text, ...RTL_TEXT },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  brand: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, flexShrink: 1 },
  allGood: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  allGoodText: { fontFamily: fonts.medium, fontSize: 15, color: colors.success },
});
