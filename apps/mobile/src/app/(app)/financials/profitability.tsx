// /financials/profitability — mobile Product + Category profitability.
//
// Two tabs (Segmented): "By product" and "By category". Both tabs share the
// same preset chips + sort chip row. Product tab also has search. Profit /
// margin columns are hidden if the server returned `seesProfit: false`
// (view_profit permission handled server-side via field redaction).

import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { FlashList, type ListRenderItem } from "@shopify/flash-list";

import { Screen } from "@/components/layout/Screen";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { Segmented } from "@/components/ui/Segmented";
import {
  SkeletonListRow,
  SkeletonPaginationFooter,
} from "@/components/ui/skeleton";
import { PresetChips } from "@/components/financials/PresetChips";
import {
  useCategoryProfitability,
  useProductProfitability,
  type CategoryProfitRow,
  type FinancialsRange,
  type ProductProfitRow,
  type ProfitSortKey,
} from "@/hooks/useFinance";
import { useSession } from "@/stores/session";
import { useDebounced } from "@/lib/useDebounced";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

type Tab = "products" | "categories";
type Row<T> = { kind: "row"; row: T } | { kind: "footer-loading" };

export default function ProfitabilityScreen() {
  const [tab, setTab] = useState<Tab>("products");
  const [range, setRange] = useState<FinancialsRange>({ preset: "this_month" });
  const [sort, setSort] = useState<ProfitSortKey>("revenue");
  const [searchDraft, setSearchDraft] = useState("");
  const search = useDebounced(searchDraft, 300);

  const me = useSession((s) => s.me);
  const perms = new Set(me?.permissions ?? []);
  const canView = me?.isOwner || perms.has("view_financials");

  if (!canView) {
    return (
      <Screen title={t("mobile.financials.profitability.title")}>
        <Card>
          <Text style={styles.err}>{t("mobile.financials.expenses.noViewPermission")}</Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen title={t("mobile.financials.profitability.title")}>
      <Segmented
        items={[
          { key: "products", label: t("mobile.financials.profitability.tabProducts") },
          { key: "categories", label: t("mobile.financials.profitability.tabCategories") },
        ]}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
      />

      <PresetChips value={range} onChange={setRange} />

      <View style={styles.sortRow}>
        <Text style={styles.sortLabel}>
          {t("mobile.financials.profitability.sort")}:
        </Text>
        {(["revenue", "grossProfit", "margin", "quantity"] as ProfitSortKey[]).map((s) => (
          <Pressable
            key={s}
            onPress={() => setSort(s)}
            style={[styles.sortChip, sort === s && styles.sortChipActive]}
            accessibilityRole="button"
          >
            <Text
              style={[styles.sortChipText, sort === s && styles.sortChipTextActive]}
            >
              {t(`mobile.financials.profitability.sort${capitalize(s)}` as never)}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === "products" ? (
        <>
          <SearchField
            value={searchDraft}
            onChangeText={setSearchDraft}
            placeholder={t("mobile.financials.profitability.searchPlaceholder")}
          />
          <ProductsTab range={range} sort={sort} search={search} />
        </>
      ) : (
        <CategoriesTab range={range} sort={sort} />
      )}
    </Screen>
  );
}

function ProductsTab({
  range,
  sort,
  search,
}: {
  range: FinancialsRange;
  sort: ProfitSortKey;
  search: string;
}) {
  const q = useProductProfitability({
    range,
    sort,
    search: search.trim() || undefined,
    limit: 30,
  });

  const rows: Row<ProductProfitRow>[] = useMemo(() => {
    const flat: Row<ProductProfitRow>[] = (q.data?.pages ?? []).flatMap((p) =>
      (p.data ?? []).map((r) => ({ kind: "row" as const, row: r })),
    );
    if (q.isFetchingNextPage) flat.push({ kind: "footer-loading" });
    return flat;
  }, [q.data, q.isFetchingNextPage]);

  const seesProfit = q.data?.pages[0]?.seesProfit ?? false;

  if (q.isPending && !q.data) return <SkeletonListRow count={6} />;
  if (rows.length === 0)
    return <EmptyState title={t("mobile.financials.profitability.empty")} />;

  const renderItem: ListRenderItem<Row<ProductProfitRow>> = ({ item }) => {
    if (item.kind === "footer-loading") return <SkeletonPaginationFooter />;
    const r = item.row;
    return (
      <View style={styles.row}>
        <View style={styles.rowMain}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {r.productName}
          </Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {(r.brand ?? "—")}
            {" · "}
            {t("mobile.financials.profitability.colQuantity")}: {r.quantitySold}
          </Text>
        </View>
        <View style={styles.rowRight}>
          <Text style={styles.rowAmount}>{money(r.revenue)}</Text>
          {seesProfit && r.grossProfit !== null && r.margin !== null ? (
            <Text
              style={[
                styles.rowMargin,
                { color: r.grossProfit >= 0 ? colors.success : colors.danger },
              ]}
            >
              {money(r.grossProfit)} · {(r.margin * 100).toFixed(1)}%
            </Text>
          ) : null}
        </View>
      </View>
    );
  };

  return (
    <FlashList
      data={rows}
      renderItem={renderItem}
      keyExtractor={(item, i) =>
        item.kind === "footer-loading" ? `f-${i}` : item.row.productId
      }
      onEndReachedThreshold={0.6}
      onEndReached={() => {
        if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
      }}
      ItemSeparatorComponent={() => <View style={styles.sep} />}
    />
  );
}

function CategoriesTab({
  range,
  sort,
}: {
  range: FinancialsRange;
  sort: ProfitSortKey;
}) {
  const q = useCategoryProfitability({ range, sort });

  if (q.isPending && !q.data) return <SkeletonListRow count={6} />;
  if (!q.data || (q.data.data ?? []).length === 0)
    return <EmptyState title={t("mobile.financials.profitability.empty")} />;

  const seesProfit = q.data.seesProfit;
  const rows = q.data.data ?? [];

  const renderItem: ListRenderItem<CategoryProfitRow> = ({ item: r }) => (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {r.categoryNameAr || r.categoryNameEn || "—"}
        </Text>
        <Text style={styles.rowMeta}>
          {t("mobile.financials.profitability.colQuantity")}: {r.quantitySold}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.rowAmount}>{money(r.revenue)}</Text>
        {seesProfit && r.grossProfit !== null && r.margin !== null ? (
          <Text
            style={[
              styles.rowMargin,
              { color: r.grossProfit >= 0 ? colors.success : colors.danger },
            ]}
          >
            {money(r.grossProfit)} · {(r.margin * 100).toFixed(1)}%
          </Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <FlashList
      data={rows}
      renderItem={renderItem}
      keyExtractor={(item) => item.categoryId ?? "no-cat"}
      ItemSeparatorComponent={() => <View style={styles.sep} />}
    />
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const styles = StyleSheet.create({
  err: { ...RTL_TEXT, fontSize: 14, color: colors.danger },
  sortRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  sortLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.textSecondary,
  },
  sortChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  sortChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  sortChipText: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 11,
    color: colors.textSecondary,
  },
  sortChipTextActive: { color: colors.card },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowMain: { flex: 1, paddingEnd: spacing.md },
  rowTitle: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  rowMeta: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  rowRight: { alignItems: "flex-end", gap: 2 },
  rowAmount: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  rowMargin: {
    fontFamily: fonts.regular,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  sep: { height: spacing.xs },
});
