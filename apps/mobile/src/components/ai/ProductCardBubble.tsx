import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * ProductCardBubble — one grounded product from the Storo database. The
 * backend's F3 grounding guard guarantees that `productId` was returned by
 * a real search_products / get_product call this turn (hallucinated ids are
 * stripped before we ever receive the block).
 */
export function ProductCardBubble({ block }: { block: ai.ProductCardBlock }) {
  const stockLabel =
    block.stockState === "out_of_stock"
      ? t("mobile.insights.ai.productCard.outOfStock")
      : block.stockState === "low_stock"
        ? t("mobile.insights.ai.productCard.lowStock", { n: block.quantity })
        : t("mobile.insights.ai.productCard.inStock", { n: block.quantity });
  const stockStyle =
    block.stockState === "out_of_stock"
      ? styles.stockDanger
      : block.stockState === "low_stock"
        ? styles.stockWarn
        : styles.stockOk;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text numberOfLines={2} style={styles.name}>
          {block.name}
        </Text>
        {block.brand ? (
          <Text numberOfLines={1} style={styles.brand}>
            {block.brand}
          </Text>
        ) : null}
      </View>
      <View style={styles.priceRow}>
        <Text style={styles.price}>{money(block.price)}</Text>
        <View style={[styles.stockChip, stockStyle]}>
          <Text style={styles.stockText}>{stockLabel}</Text>
        </View>
      </View>
      {block.sku ? (
        <Text style={styles.sku}>
          {t("mobile.insights.ai.productCard.sku", { sku: block.sku })}
        </Text>
      ) : null}
      {block.caption ? <Text style={styles.caption}>{block.caption}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  name: {
    ...RTL_TEXT,
    flex: 1,
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.text,
  },
  brand: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.textSecondary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    overflow: "hidden",
  },
  priceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
  },
  price: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 18,
    color: colors.accent,
    fontVariant: ["tabular-nums"],
  },
  stockChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
  },
  stockText: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 11,
  },
  stockOk: { backgroundColor: "#EAFAF1" },
  stockWarn: { backgroundColor: "#FFEDD4" },
  stockDanger: { backgroundColor: colors.dangerLight },
  sku: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
  caption: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textSecondary,
  },
});
