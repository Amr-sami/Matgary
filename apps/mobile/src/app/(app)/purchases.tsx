import { useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Plus, Receipt, Wallet, Package } from "phosphor-react-native";
import { ApiError, catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { isRTL, t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { SearchField } from "@/components/ui/SearchField";
import { StatCard } from "@/components/ui/StatCard";
import { money, shortDate } from "@/lib/format";
import { RTL_TEXT, directionStyle } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/** Arabic labels + badge variant per PO status, matching the web's Badge use. */
const STATUS = (): Record<string, { label: string; variant: "accent" | "success" | "lowstock" | "neutral" }> => ({
  draft: { label: t("app.purchasesStatus.draft"), variant: "neutral" },
  ordered: { label: t("mobile.purchases.ordered"), variant: "accent" },
  received: { label: t("app.purchasesStatus.received"), variant: "success" },
  cancelled: { label: t("app.purchasesStatus.cancelled"), variant: "lowstock" },
});

/** Port of app__purchases.png — PO list with totals and payment state. */
type Draft = { productId: string; productName: string; quantity: number; unitCost: number };

export default function PurchasesScreen() {
  const qc = useQueryClient();
  const pos = useQuery({
    queryKey: ["purchase-orders"],
    queryFn: () => catalog.listPurchaseOrders(api),
  });
  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: () => catalog.listSuppliers(api) });
  const products = useQuery({ queryKey: ["products"], queryFn: () => catalog.listProducts(api) });

  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);

  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return (products.data ?? []).filter((p) => p.name.toLowerCase().includes(t)).slice(0, 6);
  }, [products.data, q]);

  const addItem = (p: { id: string; name: string; costPrice: number }) => {
    setItems((cur) => cur.some((i) => i.productId === p.id)
      ? cur.map((i) => i.productId === p.id ? { ...i, quantity: i.quantity + 1 } : i)
      : [...cur, { productId: p.id, productName: p.name, quantity: 1, unitCost: p.costPrice }]);
    setQ("");
  };
  const bump = (id: string, d: number) =>
    setItems((cur) => cur.map((i) => i.productId === id ? { ...i, quantity: i.quantity + d } : i).filter((i) => i.quantity > 0));

  const draftTotal = items.reduce((s, i) => s + i.quantity * i.unitCost, 0);

  const create = useMutation({
    mutationFn: () => catalog.createPurchaseOrder(api, { supplierId: supplierId!, items }),
    onSuccess: () => {
      setOpen(false); setSupplierId(null); setItems([]); setError(null);
      void qc.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
    onError: (e) => setError(e instanceof ApiError && e.kind === "offline" ? t("mobile.common.offline") : t("mobile.purchases.createFailed")),
  });
  const canSubmit = supplierId !== null && items.length > 0 && !create.isPending;

  const orders = pos.data ?? [];

  const stats = useMemo(() => {
    const total = orders.reduce((s, o) => s + o.total, 0);
    const paid = orders.reduce((s, o) => s + o.paidAmount, 0);
    return { count: orders.length, total, outstanding: total - paid };
  }, [orders]);

  return (
    <Screen
      title={t("app.purchases.title")}
      onRefresh={() => void pos.refetch()}
      refreshing={pos.isRefetching}
    >
      <View style={styles.gridRow}>
        <StatCard title={t("mobile.purchases.orderCount")} value={String(stats.count)} icon={Receipt} color="accent" />
        <StatCard title={t("app.purchases.kpi.totalPurchases")} value={money(stats.total)} icon={Package} color="accent" />
      </View>
      <View style={styles.gridRow}>
        <StatCard
          title={t("mobile.purchases.owedToSuppliers")}
          value={money(stats.outstanding)}
          icon={Wallet}
          color={stats.outstanding > 0 ? "danger" : "success"}
        />
        <View style={styles.spacer} />
      </View>

      <Button label={t("app.purchases.newOrder")} onPress={() => setOpen(true)} />

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={[styles.modal, directionStyle(isRTL())]}>
          <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>{t("app.purchases.newOrder")}</Text>

            <Text style={styles.meta}>{t("app.suppliers.detail.title")}</Text>
            <View style={styles.chipRow}>
              {(suppliers.data ?? []).map((sp) => (
                <Chip key={sp.id} label={sp.name} active={supplierId === sp.id} onPress={() => setSupplierId(sp.id)} />
              ))}
            </View>

            <Text style={styles.meta}>{t("app.activityLabels.fields.lines")}</Text>
            <SearchField value={q} onChangeText={setQ} placeholder={t("mobile.purchases.searchProduct")} />
            {matches.map((p) => (
              <Pressable key={p.id} style={styles.pick} onPress={() => addItem(p)}>
                <Text numberOfLines={1} style={styles.supplier}>{p.name}</Text>
                <Text style={styles.meta}>{t("mobile.purchases.cost", { amount: money(p.costPrice) })}</Text>
              </Pressable>
            ))}
            {items.map((i) => (
              <View key={i.productId} style={styles.draftRow}>
                <Text numberOfLines={1} style={[styles.supplier, { flex: 1 }]}>{i.productName}</Text>
                <Pressable style={styles.qtyBtn} onPress={() => bump(i.productId, -1)}><Minus size={14} color={colors.accent} weight="bold" /></Pressable>
                <Text style={styles.qty}>{i.quantity}</Text>
                <Pressable style={styles.qtyBtn} onPress={() => bump(i.productId, 1)}><Plus size={14} color={colors.accent} weight="bold" /></Pressable>
                <Text style={styles.total}>{money(i.quantity * i.unitCost)}</Text>
              </View>
            ))}
            {items.length ? <Text style={styles.total}>{t("mobile.purchases.total", { amount: money(draftTotal) })}</Text> : null}

            {error ? <Text style={styles.err}>{error}</Text> : null}
            <Button label={t("mobile.purchases.create")} disabled={!canSubmit} loading={create.isPending} onPress={() => create.mutate()} />
            <Button label={t("app.purchases.row.cancel")} variant="ghost" onPress={() => setOpen(false)} />
          </ScrollView>
        </View>
      </Modal>

      {pos.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : orders.length === 0 ? (
        <EmptyState title={t("mobile.purchases.empty")} hint={t("mobile.purchases.emptyHint")} />
      ) : (
        <View style={styles.list}>
          {orders.map((o) => {
            const s = STATUS()[o.status] ?? { label: o.status, variant: "neutral" as const };
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
                    {t("mobile.purchases.orderMeta", { n: o.itemCount, date: shortDate(o.orderDate) })}
                  </Text>
                </View>
                {due > 0 ? (
                  <Text style={styles.due}>{t("mobile.purchases.remaining", { amount: money(due) })}</Text>
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
  modal: { flex: 1, backgroundColor: colors.bg },
  modalContent: { padding: spacing.xl, paddingTop: 60, gap: spacing.md },
  modalTitle: { fontFamily: fonts.bold, fontSize: 24, color: colors.text, ...RTL_TEXT },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  pick: { padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, gap: 2 },
  draftRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  qtyBtn: { width: 32, height: 32, borderRadius: radius.md, borderWidth: 1, borderColor: colors.accent, alignItems: "center", justifyContent: "center" },
  qty: { minWidth: 24, textAlign: "center", fontFamily: fonts.bold, fontSize: 14, color: colors.text },
  err: { fontFamily: fonts.medium, fontSize: 14, color: colors.danger, textAlign: "center" },
});
