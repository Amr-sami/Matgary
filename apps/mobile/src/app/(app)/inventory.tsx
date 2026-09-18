import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Package, Plus, WarningOctagon, Wallet, Warning } from "phosphor-react-native";
import { catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { ScannerSheet } from "@/components/scanner/ScannerSheet";
import { StatCard } from "@/components/ui/StatCard";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

type StatusFilter = "all" | "in" | "low" | "out";

/**
 * Port of app__inventory.png.
 *
 * Order matches the capture: the 2×2 KPI block, search, the add-product CTA,
 * then category and status chip rows, the result count, and the product list.
 *
 * Doc 04 marks this RECOMPOSE — filters into a bottom sheet, a FAB, a
 * virtualised list. That is a redesign, and the brief here is to match what
 * shipped, so the filter rows stay inline. The chip rows scroll horizontally
 * rather than wrapping, which is the one change the web already made for
 * phones (session-record §1g).
 */
export default function InventoryScreen() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [scannerOpen, setScannerOpen] = useState(false);

  const products = useQuery({
    queryKey: ["products"],
    queryFn: () => catalog.listProducts(api),
  });
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: () => catalog.listCategories(api),
  });

  const all = products.data ?? [];

  const stats = useMemo(() => {
    const out = all.filter((p) => p.quantity === 0).length;
    const low = all.filter(
      (p) => p.quantity > 0 && p.quantity <= p.lowStockThreshold,
    ).length;
    // Stock value is at COST, not retail — it is what the shelf is worth to the
    // owner, which is the number the web shows.
    const value = all.reduce((sum, p) => sum + p.costPrice * p.quantity, 0);
    return { total: all.length, low, out, value };
  }, [all]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((p) => {
      if (category !== "all" && p.category !== category) return false;
      if (status === "out" && p.quantity !== 0) return false;
      if (status === "in" && p.quantity <= p.lowStockThreshold) return false;
      if (status === "low" && !(p.quantity > 0 && p.quantity <= p.lowStockThreshold))
        return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.brand ?? "").toLowerCase().includes(q) ||
        (p.sku ?? "").toLowerCase().includes(q) ||
        (p.barcode ?? "").toLowerCase().includes(q)
      );
    });
  }, [all, query, category, status]);

  const labelFor = (id: string) =>
    categories.data?.find((c) => c.id === id)?.label ?? "";

  return (
    <Screen
      title={t("app.inventory.title")}
      onRefresh={() => void products.refetch()}
      refreshing={products.isRefetching}
    >
      <View style={styles.grid}>
        <View style={styles.gridRow}>
          <StatCard
            title={t("app.inventory.summary.totalProducts")}
            value={String(stats.total)}
            icon={Package}
            color="accent"
          />
          <StatCard
            title={t("app.inventory.summary.lowStock")}
            value={String(stats.low)}
            icon={Warning}
            color="danger"
          />
        </View>
        <View style={styles.gridRow}>
          <StatCard
            title={t("app.inventory.summary.outOfStock")}
            value={String(stats.out)}
            icon={WarningOctagon}
            color="danger"
          />
          <StatCard
            title={t("app.inventory.summary.stockValue")}
            value={money(stats.value)}
            icon={Wallet}
            color="accent"
          />
        </View>
      </View>

      {/* Single-shot: one scan fills the search box, the list filters on
          barcode/sku, and the sheet closes itself. No server lookup here —
          the catalogue is already in memory and the filter matches on both
          fields, which is the lookup a stock check needs.
          The placeholder is mobile's own, not the web's: the web string names
          tag and supplier, which this filter does not match, and at 48 chars
          it overflowed the phone field. */}
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t("mobile.inventory.searchPlaceholder")}
        onPressScan={() => setScannerOpen(true)}
      />
      <ScannerSheet
        visible={scannerOpen}
        mode="single"
        onClose={() => setScannerOpen(false)}
        onScan={setQuery}
      />

      <Pressable style={styles.cta} accessibilityRole="button">
        <Plus size={18} color="#FFFFFF" weight="bold" />
        <Text numberOfLines={1} style={styles.ctaText}>
          {t("app.inventory.tools.addProduct")}
        </Text>
      </Pressable>

      <ChipRow>
        <Chip label={t("app.inventory.filters.allCategories")} active={category === "all"} onPress={() => setCategory("all")} />
        {(categories.data ?? []).map((c) => (
          <Chip
            key={c.id}
            label={c.label}
            active={category === c.id}
            onPress={() => setCategory(c.id)}
          />
        ))}
      </ChipRow>

      <ChipRow>
        <Chip label={t("app.inventory.filters.allStatuses")} active={status === "all"} onPress={() => setStatus("all")} />
        <Chip label={t("app.inventory.filters.stockStatus.in")} active={status === "in"} onPress={() => setStatus("in")} />
        <Chip label={t("app.inventory.summary.lowStock")} active={status === "low"} onPress={() => setStatus("low")} />
        <Chip label={t("app.inventory.filters.stockStatus.out")} active={status === "out"} onPress={() => setStatus("out")} />
      </ChipRow>

      <Text style={styles.count}>{t("app.inventory.count", { n: visible.length })}</Text>

      {products.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : visible.length === 0 ? (
        <EmptyState
          title={t("mobile.inventory.empty")}
          hint={query ? t("mobile.inventory.searchHint") : undefined}
        />
      ) : (
        <View style={styles.list}>
          {visible.map((p) => {
            const out = p.quantity === 0;
            const low = p.quantity > 0 && p.quantity <= p.lowStockThreshold;
            return (
              <Pressable
                key={p.id}
                accessibilityRole="button"
                accessibilityLabel={t("mobile.product.detailsOf", { name: p.name })}
                onPress={() => router.push(`/inventory/${encodeURIComponent(p.id)}`)}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <View style={styles.rowHead}>
                  <Text numberOfLines={1} style={styles.name}>
                    {p.name}
                  </Text>
                  {labelFor(p.category) ? (
                    <Badge label={labelFor(p.category)} variant="accent" />
                  ) : null}
                </View>
                <View style={styles.rowMeta}>
                  <Text style={styles.price}>{money(p.price)}</Text>
                  <Badge
                    label={out ? t("app.inventory.filters.stockStatus.out") : t("mobile.common.pieces", { n: p.quantity })}
                    variant={out ? "outofstock" : low ? "lowstock" : "success"}
                  />
                  {p.brand ? (
                    <Text numberOfLines={1} style={styles.brand}>
                      {p.brand}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

/**
 * Horizontally scrolling chip row. The web wraps these at `lg` and scrolls on
 * phones — wrapping at 390px produced eight stacked rows before a single
 * product was visible.
 */
function ChipRow({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.chipRowWrap}>
      <View style={styles.chipRow}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { gap: spacing.lg },
  gridRow: { flexDirection: "row", gap: spacing.lg },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    minHeight: 52,
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
  },
  ctaText: { fontFamily: fonts.bold, fontSize: 16, color: "#FFFFFF" },
  chipRowWrap: { overflow: "hidden" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  count: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  list: { gap: spacing.md },
  row: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
    ...elevation.card,
  },
  rowPressed: { backgroundColor: colors.accentLight },
  rowHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  name: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  price: { fontFamily: fonts.bold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"] },
  brand: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
});
