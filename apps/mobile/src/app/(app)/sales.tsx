import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  ChatText,
  Basket,
  Percent,
  TrendUp,
  Wallet,
} from "phosphor-react-native";
import { catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { StatCard } from "@/components/ui/StatCard";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Port of app__sales-pos.png — with ONE deliberate reordering.
 *
 * The capture opens on five analytics cards and puts "تسجيل بيع جديد" far below
 * the fold. Doc 04 and the README's finding #3 both call that out as the
 * single highest-value fix in the port: a cashier opens this screen to take
 * money, not to read a margin report. So the sale panel comes first here and
 * the KPI block follows.
 *
 * The content is otherwise identical — same five metrics, same icons, same
 * recent-products affordance.
 */
export default function SalesScreen() {
  const [query, setQuery] = useState("");

  const sales = useQuery({ queryKey: ["sales"], queryFn: () => catalog.listSales(api) });
  const products = useQuery({
    queryKey: ["products"],
    queryFn: () => catalog.listProducts(api),
  });

  const lines = sales.data ?? [];

  const stats = useMemo(() => {
    const now = Date.now();
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    const recent = lines.filter((l) => {
      const t = l.saleDate ? new Date(l.saleDate).getTime() : now;
      return t >= cutoff;
    });

    const revenue = recent.reduce(
      (s, l) => s + (l.totalPrice ?? l.pricePerUnit * l.quantitySold),
      0,
    );
    const cost = recent.reduce((s, l) => s + (l.costPrice ?? 0) * l.quantitySold, 0);
    // Invoices, not lines: one sale of three items is one invoice.
    const invoices = new Set(recent.map((l) => l.invoiceId)).size;

    return {
      revenue,
      invoices,
      avgInvoice: invoices ? revenue / invoices : 0,
      profit: revenue - cost,
    };
  }, [lines]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (products.data ?? [])
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.sku ?? "").toLowerCase().includes(q) ||
          (p.barcode ?? "").toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [products.data, query]);

  // "منتجات حديثة" — the last distinct products actually sold, which is what a
  // cashier reaches for most often.
  const recentProducts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const l of lines) {
      if (!seen.has(l.productId)) seen.set(l.productId, l.productName);
      if (seen.size >= 5) break;
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [lines]);

  return (
    <Screen onRefresh={() => void sales.refetch()} refreshing={sales.isRefetching}>
      <Card title="تسجيل بيع جديد">
        <Text style={styles.label}>ابحث أو امسح المنتج</Text>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="الاسم أو SKU أو الباركود…"
        />

        {query.trim() ? (
          matches.length ? (
            <View style={styles.results}>
              {matches.map((p) => (
                <Pressable key={p.id} style={styles.result}>
                  <Text numberOfLines={1} style={styles.resultName}>
                    {p.name}
                  </Text>
                  <Text style={styles.resultPrice}>{money(p.price)}</Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <Text style={styles.noMatch}>لا يوجد منتج بهذا الاسم أو الباركود</Text>
          )
        ) : (
          <>
            <Text style={styles.label}>منتجات حديثة:</Text>
            <View style={styles.pillRow}>
              {recentProducts.map((p) => (
                <Pressable key={p.id} style={styles.pill}>
                  <Text numberOfLines={1} style={styles.pillText}>
                    {p.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        )}
      </Card>

      {sales.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : lines.length === 0 ? (
        <EmptyState title="لا توجد مبيعات بعد" />
      ) : (
        <View style={styles.grid}>
          <View style={styles.gridRow}>
            <StatCard
              title="صافي المبيعات"
              value={money(stats.revenue)}
              icon={Wallet}
              color="accent"
            />
            <StatCard
              title="فواتير آخر 30 يوم"
              value={String(stats.invoices)}
              icon={ChatText}
              color="accent"
            />
          </View>
          <View style={styles.gridRow}>
            <StatCard
              title="متوسط الفاتورة"
              value={money(stats.avgInvoice)}
              icon={Basket}
              color="accent"
            />
            <StatCard
              title="صافي الربح"
              value={money(stats.profit)}
              icon={TrendUp}
              color="success"
            />
          </View>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    ...RTL_TEXT,
  },
  pillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  pill: {
    backgroundColor: colors.accentLight,
    borderRadius: radius.full,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    justifyContent: "center",
    flexShrink: 1,
  },
  pillText: { fontFamily: fonts.medium, fontSize: 14, color: colors.accent },
  results: { marginTop: spacing.md, gap: spacing.sm },
  result: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  resultName: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 15, color: colors.text, ...RTL_TEXT },
  resultPrice: { fontFamily: fonts.bold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"] },
  noMatch: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.md,
    ...RTL_TEXT,
  },
  grid: { gap: spacing.lg },
  gridRow: { flexDirection: "row", gap: spacing.lg },
});
