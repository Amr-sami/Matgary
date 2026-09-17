import { useMemo } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Receipt, Wallet, Package } from "phosphor-react-native";
import { catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatCard } from "@/components/ui/StatCard";
import { money, shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/** Arabic labels + badge variant per PO status, matching the web's Badge use. */
const STATUS: Record<string, { label: string; variant: "accent" | "success" | "lowstock" | "neutral" }> = {
  draft: { label: "مسودة", variant: "neutral" },
  ordered: { label: "تم الطلب", variant: "accent" },
  received: { label: "تم الاستلام", variant: "success" },
  cancelled: { label: "ملغي", variant: "lowstock" },
};

/** Port of app__purchases.png — PO list with totals and payment state. */
export default function PurchasesScreen() {
  const pos = useQuery({
    queryKey: ["purchase-orders"],
    queryFn: () => catalog.listPurchaseOrders(api),
  });

  const orders = pos.data ?? [];

  const stats = useMemo(() => {
    const total = orders.reduce((s, o) => s + o.total, 0);
    const paid = orders.reduce((s, o) => s + o.paidAmount, 0);
    return { count: orders.length, total, outstanding: total - paid };
  }, [orders]);

  return (
    <Screen
      title="المشتريات"
      onRefresh={() => void pos.refetch()}
      refreshing={pos.isRefetching}
    >
      <View style={styles.gridRow}>
        <StatCard title="عدد الأوامر" value={String(stats.count)} icon={Receipt} color="accent" />
        <StatCard title="إجمالي المشتريات" value={money(stats.total)} icon={Package} color="accent" />
      </View>
      <View style={styles.gridRow}>
        <StatCard
          title="مستحق للموردين"
          value={money(stats.outstanding)}
          icon={Wallet}
          color={stats.outstanding > 0 ? "danger" : "success"}
        />
        <View style={styles.spacer} />
      </View>

      {pos.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : orders.length === 0 ? (
        <EmptyState title="لا توجد أوامر شراء" hint="أضف أمر شراء لتتبع مشترياتك من الموردين." />
      ) : (
        <View style={styles.list}>
          {orders.map((o) => {
            const s = STATUS[o.status] ?? { label: o.status, variant: "neutral" as const };
            const due = o.total - o.paidAmount;
            return (
              <View key={o.id} style={styles.row}>
                <View style={styles.rowHead}>
                  <Text numberOfLines={1} style={styles.supplier}>
                    {o.supplierName}
                  </Text>
                  <Badge label={s.label} variant={s.variant} />
                </View>
                <View style={styles.rowMeta}>
                  <Text style={styles.total}>{money(o.total)}</Text>
                  <Text style={styles.meta}>
                    {o.itemCount} صنف · {shortDate(o.orderDate)}
                  </Text>
                </View>
                {due > 0 ? (
                  <Text style={styles.due}>متبقي {money(due)}</Text>
                ) : null}
              </View>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  gridRow: { flexDirection: "row", gap: spacing.lg },
  spacer: { flex: 1 },
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
  rowHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  supplier: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  total: { fontFamily: fonts.bold, fontSize: 16, color: colors.text, fontVariant: ["tabular-nums"] },
  meta: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  due: { fontFamily: fonts.medium, fontSize: 13, color: colors.danger, ...RTL_TEXT },
});
