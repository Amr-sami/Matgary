import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { FlashList } from "@shopify/flash-list";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PackageIcon as Package } from "phosphor-react-native/src/icons/Package";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";
import { WarningOctagonIcon as WarningOctagon } from "phosphor-react-native/src/icons/WarningOctagon";
import { WalletIcon as Wallet } from "phosphor-react-native/src/icons/Wallet";
import { WarningIcon as Warning } from "phosphor-react-native/src/icons/Warning";
import { catalog, type Product } from "@matgary/api-client";

import { API_BASE_URL, api } from "@/api/client";
import { HeaderAccessories } from "@/components/shell/HeaderAccessories";
import { Badge } from "@/components/ui/Badge";
import { ChevronForward } from "@/components/ui/Chevron";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { ScannerSheet } from "@/components/scanner/ScannerSheet";
import { StatCard } from "@/components/ui/StatCard";
import { money } from "@/lib/format";
import { RTL, RTL_TEXT } from "@/theme/rtl";
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
 * virtualised list. The bottom sheet and FAB are a redesign, and the brief
 * here is to match what shipped, so the filter rows stay inline. The list IS
 * virtualised: spec §10.3 budgets "inventory, 2,000 items — 60fps, zero blank
 * cells", so the screen is one FlashList whose ListHeaderComponent carries
 * everything above the rows (the same frame components/layout/Screen draws,
 * minus its ScrollView — a list inside a ScrollView would not recycle). The
 * chip rows scroll horizontally rather than wrapping, which is the one change
 * the web already made for phones (session-record §1g).
 */
export default function InventoryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
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

  // One lookup per render rather than a find() per row — 2,000 rows × N
  // categories is the kind of thing that costs frames while scrolling.
  const categoryLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories.data ?? []) map.set(c.id, c.label);
    return map;
  }, [categories.data]);

  // Same frame as components/layout/Screen: the accessories row, then the
  // title shrink-wrapped to the reading edge (alignItems flex-start), then
  // everything the capture shows above the first product row.
  const header = (
    <View style={styles.headerWrap}>
      <View style={styles.titleBlock}>
        <HeaderAccessories />
        <Text style={styles.title}>{t("app.inventory.title")}</Text>
      </View>

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

      <Pressable style={styles.cta} accessibilityRole="button" onPress={() => router.push("/add-product")}>
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

      {/* With a filter applied the number is the MATCH count, not the size of
          the inventory — the stat card above still says 24 while this says 3. */}
      <Text style={styles.count}>
        {query.trim() || category !== "all" || status !== "all"
          ? t("mobile.inventory.matchCount", { n: visible.length })
          : t("app.inventory.count", { n: visible.length })}
      </Text>
    </View>
  );

  const empty = products.isLoading ? (
    <ActivityIndicator color={colors.accent} />
  ) : (
    <EmptyState
      title={t("mobile.inventory.empty")}
      hint={query ? t("mobile.inventory.searchHint") : undefined}
    />
  );

  return (
    <View style={styles.root}>
      {/* Opaque status-bar band: the list scrolls under the clock otherwise. */}
      <View style={{ height: insets.top, backgroundColor: colors.bg }} />
      <FlashList
        data={visible}
        keyExtractor={(p) => p.id}
        renderItem={({ item }) => (
          <ProductRow
            p={item}
            categoryLabel={categoryLabels.get(item.category) ?? ""}
            onPress={() => router.push(`/inventory/${encodeURIComponent(item.id)}`)}
          />
        )}
        ItemSeparatorComponent={Separator}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        refreshControl={
          <RefreshControl refreshing={products.isRefetching} onRefresh={() => void products.refetch()} />
        }
        contentContainerStyle={[styles.content, { paddingTop: spacing.lg }]}
        keyboardShouldPersistTaps="handled"
      />

      {/* A Modal with its own native root, so it sits beside the list rather
          than inside its header — a recycled header cell must not own it. */}
      <ScannerSheet
        visible={scannerOpen}
        mode="single"
        onClose={() => setScannerOpen(false)}
        onScan={setQuery}
      />
    </View>
  );
}

function ProductRow({
  p,
  categoryLabel,
  onPress,
}: {
  p: Product;
  categoryLabel: string;
  onPress: () => void;
}) {
  const out = p.quantity === 0;
  const low = p.quantity > 0 && p.quantity <= p.lowStockThreshold;
  const thumb = catalog.resolveUploadUrl(API_BASE_URL, p.imageUrl);
  return (
    <Pressable
      accessibilityRole="button"
      testID="inventory-row"
      accessibilityLabel={t("mobile.product.detailsOf", { name: p.name })}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {thumb ? (
        <Image
          source={{ uri: thumb }}
          style={styles.thumb}
          contentFit="cover"
          transition={100}
          recyclingKey={p.id}
          accessibilityLabel={t("mobile.product.a11yPhotoPreview")}
        />
      ) : null}
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text numberOfLines={1} style={styles.name}>
            {p.name}
          </Text>
          {categoryLabel ? <Badge label={categoryLabel} variant="accent" /> : null}
        </View>
        <View style={styles.rowMeta}>
          <Text style={styles.price}>{money(p.price)}</Text>
          <Badge
            label={out ? t("app.inventory.filters.stockStatus.out") : t(`mobile.common.pieces${countForm(p.quantity)}`, { n: p.quantity })}
            variant={out ? "outofstock" : low ? "lowstock" : "success"}
          />
          {p.brand ? (
            <Text numberOfLines={1} style={styles.brand}>
              {p.brand}
            </Text>
          ) : null}
        </View>
      </View>
      {/* Same disclosure the sales-history rows carry: one affordance for
          "this row opens a detail screen". */}
      <ChevronForward size={16} color={colors.textSecondary} />
    </Pressable>
  );
}

/** Arabic counts 1 / 2 / 3–10 / 11+ differently; the dictionary carries One/Two/Few beside the default. */
function countForm(n: number): string {
  return n === 1 ? "One" : n === 2 ? "Two" : n >= 3 && n <= 10 ? "Few" : "";
}

/** The `gap` the old `<View style={styles.list}>` had between cards. */
function Separator() {
  return <View style={styles.separator} />;
}

/**
 * Horizontally scrolling chip row. The web wraps these at `lg` and scrolls on
 * phones — wrapping at 390px produced eight stacked rows before a single
 * product was visible.
 */
function ChipRow({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.chipRowWrap}
      contentContainerStyle={styles.chipRow}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, ...RTL },
  content: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl * 2,
  },
  headerWrap: { gap: spacing.lg, marginBottom: spacing.lg },
  titleBlock: { gap: 4, alignItems: "flex-start" },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },
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
  ctaText: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 16, color: "#FFFFFF" },
  // Bleeds to the screen edge so a half-visible chip signals "more"; the
  // first chip still lines up with the page gutter via the content padding.
  chipRowWrap: { marginHorizontal: -spacing.lg },
  chipRow: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg },
  count: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  separator: { height: spacing.md },
  row: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    ...elevation.card,
  },
  rowPressed: { backgroundColor: colors.accentLight },
  thumb: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.neutralTint },
  rowBody: { flex: 1, minWidth: 0, gap: spacing.sm },
  rowHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  name: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  price: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"] },
  brand: { ...RTL_TEXT, flexShrink: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
});
