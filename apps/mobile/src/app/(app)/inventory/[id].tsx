import { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Barcode, Coins, Package, Tag, Wallet } from "phosphor-react-native";
import { ApiError, catalog, type Supplier } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { ChevronBack } from "@/components/ui/Chevron";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/StatCard";
import { money, shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Product detail (/inventory/<id>).
 *
 * NO capture exists for this screen — the web has no product detail page, it
 * edits products in a modal off the inventory table. So this is composed, not
 * ported: the inventory row's own vocabulary (name, category badge, stock
 * badge, price) promoted into a header card, the four figures the inventory
 * KPI block already uses for the whole shelf shown here for one product, and
 * the remaining columns of the web's edit form as a labelled list. Every label
 * is lifted from apps/web/dictionaries/ar.json (app.inventory.*), so nothing
 * here invents Arabic.
 *
 * Read-only, and it reads the SAME ["products"] query the list screen fills,
 * so opening a product costs no request and the two can never disagree.
 */
export default function ProductDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string | string[] }>();
  const id = (Array.isArray(params.id) ? params.id[0] : params.id) ?? "";

  const productsQ = useQuery({
    queryKey: ["products"],
    queryFn: () => catalog.listProducts(api),
  });
  const categoriesQ = useQuery({
    queryKey: ["categories"],
    queryFn: () => catalog.listCategories(api),
  });
  const suppliersQ = useQuery({
    queryKey: ["suppliers"],
    queryFn: async () => {
      try {
        return await catalog.listSuppliers(api);
      } catch (error) {
        // view_suppliers is a separate permission from view_inventory.
        if (error instanceof ApiError && error.kind === "forbidden") {
          return [] as Supplier[];
        }
        throw error;
      }
    },
  });

  const product = useMemo(
    () => (productsQ.data ?? []).find((p) => p.id === id) ?? null,
    [productsQ.data, id],
  );

  const categoryLabel =
    categoriesQ.data?.find((c) => c.id === product?.category)?.label ?? "";
  const supplierName =
    suppliersQ.data?.find((s) => s.id === product?.supplierId)?.name ?? null;

  /** Only string/number attribute values are printable; anything else is skipped. */
  const attributes = useMemo(() => {
    const entries: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(product?.attributes ?? {})) {
      if (typeof value === "string" && value.trim()) entries.push([key, value]);
      else if (typeof value === "number") entries.push([key, String(value)]);
    }
    return entries;
  }, [product]);

  const out = (product?.quantity ?? 0) === 0;
  const low =
    product !== null &&
    product.quantity > 0 &&
    product.quantity <= product.lowStockThreshold;
  const margin = product ? product.price - product.costPrice : 0;
  const marginPct =
    product && product.price > 0 ? Math.round((margin / product.price) * 100) : 0;

  return (
    <Screen
      onRefresh={() => void productsQ.refetch()}
      refreshing={productsQ.isRefetching}
    >
      <View style={styles.crumb}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mobile.inventory.backToList")}
          hitSlop={8}
          style={styles.crumbLink}
          onPress={() => router.navigate("/inventory")}
        >
          <Text style={styles.crumbText}>{t("app.inventory.title")}</Text>
        </Pressable>
        <ChevronBack size={14} color={colors.textSecondary} />
        <Text numberOfLines={1} style={styles.crumbCurrent}>
          {product?.name ?? ""}
        </Text>
      </View>

      {productsQ.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : !product ? (
        <Card>
          <Text style={styles.notFound}>{t("mobile.product.notFound")}</Text>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            style={styles.backLink}
            onPress={() => router.navigate("/inventory")}
          >
            <Text style={styles.backLinkText}>{t("mobile.inventory.backToList")}</Text>
          </Pressable>
        </Card>
      ) : (
        <>
          <Card>
            <View style={styles.avatar}>
              <Package size={28} color={colors.accent} />
            </View>
            <Text style={styles.name}>{product.name}</Text>
            {product.brand ? (
              <Text numberOfLines={1} style={styles.brand}>
                {product.brand}
              </Text>
            ) : null}
            <View style={styles.badgeRow}>
              {categoryLabel ? <Badge label={categoryLabel} variant="accent" /> : null}
              <Badge
                label={out ? t("app.dashboard.lowStock.outOfStock") : t("mobile.common.pieces", { n: product.quantity })}
                variant={out ? "outofstock" : low ? "lowstock" : "success"}
              />
            </View>
          </Card>

          <View style={styles.gridRow}>
            <StatCard title={t("app.inventory.addProduct.step3.fields.price")} value={money(product.price)} icon={Tag} color="accent" />
            <StatCard
              title={t("app.activityLabels.fieldNames.costPrice")}
              value={money(product.costPrice)}
              icon={Coins}
              color="accent"
            />
          </View>
          <View style={styles.gridRow}>
            <StatCard
              title={t("app.common.quantity")}
              value={String(product.quantity)}
              icon={Package}
              color={out || low ? "danger" : "accent"}
            />
            <StatCard
              title={t("app.inventory.summary.stockValue")}
              value={money(product.costPrice * product.quantity)}
              icon={Wallet}
              color="accent"
            />
          </View>

          <Card title={t("app.inventory.addProduct.step3.heading")}>
            <View style={styles.details}>
              <Detail
                label={t("app.inventory.table.col.margin")}
                value={t("mobile.product.margin", { amount: money(margin), pct: marginPct })}
                tone={margin > 0 ? "success" : margin < 0 ? "danger" : "default"}
              />
              <Detail
                label={t("app.inventory.editForm.fields.lowStockThreshold")}
                value={String(product.lowStockThreshold)}
              />
              <Detail label={t("app.common.category")} value={categoryLabel || t("app.catalog.uncategorized")} />
              <Detail label={t("app.inventory.editForm.fields.brand")} value={product.brand || "—"} />
              <Detail label={t("app.suppliers.detail.title")} value={supplierName || "—"} />
              <Detail
                label={t("app.inventory.editForm.fields.sku")}
                value={product.sku || product.barcode || "—"}
                icon={<Barcode size={14} color={colors.textSecondary} />}
              />
              <Detail label={t("mobile.common.addedOn")} value={shortDate(product.createdAt)} />
              {attributes.map(([key, value]) => (
                <Detail key={key} label={key} value={value} />
              ))}
            </View>
          </Card>

          {product.tags.length > 0 ? (
            <Card title={t("mobile.common.tags")}>
              <View style={styles.tagRow}>
                {product.tags.map((tag) => (
                  <Badge key={tag} label={tag} variant="neutral" />
                ))}
              </View>
            </Card>
          ) : null}
        </>
      )}
    </Screen>
  );
}

/** Label on the start edge, value on the end edge — one line each. */
function Detail({
  label,
  value,
  tone = "default",
  icon,
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "danger";
  icon?: React.ReactNode;
}) {
  return (
    <View style={styles.detailRow}>
      <View style={styles.detailLabelWrap}>
        {icon}
        <Text numberOfLines={2} style={styles.detailLabel}>
          {label}
        </Text>
      </View>
      <Text
        numberOfLines={1}
        style={[
          styles.detailValue,
          tone === "success" && styles.detailSuccess,
          tone === "danger" && styles.detailDanger,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  crumb: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 44 },
  crumbLink: { justifyContent: "center", minHeight: 44 },
  crumbText: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  crumbCurrent: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 14, color: colors.text, ...RTL_TEXT },

  notFound: { fontFamily: fonts.regular, fontSize: 15, color: colors.textSecondary, ...RTL_TEXT },
  backLink: { minHeight: 44, justifyContent: "center" },
  backLinkText: { fontFamily: fonts.medium, fontSize: 15, color: colors.accent, ...RTL_TEXT },

  avatar: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-start",
    marginBottom: spacing.md,
  },
  name: { fontFamily: fonts.bold, fontSize: 24, color: colors.text, ...RTL_TEXT },
  brand: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 2,
    ...RTL_TEXT,
  },
  badgeRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.md,
  },

  gridRow: { flexDirection: "row", gap: spacing.lg },

  details: { gap: spacing.md },
  detailRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  detailLabelWrap: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.xs },
  detailLabel: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  detailValue: {
    flexShrink: 0,
    maxWidth: "55%",
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  detailSuccess: { color: colors.successStrong },
  detailDanger: { color: colors.danger },

  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
});
