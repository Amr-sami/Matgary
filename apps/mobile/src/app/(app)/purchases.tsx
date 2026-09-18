import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageIcon as Package } from "phosphor-react-native/src/icons/Package";
import { ReceiptIcon as Receipt } from "phosphor-react-native/src/icons/Receipt";
import { TrashIcon as Trash } from "phosphor-react-native/src/icons/Trash";
import { WalletIcon as Wallet } from "phosphor-react-native/src/icons/Wallet";
import { catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { PoBuilderSheet, describeError } from "@/components/purchases/PoBuilderSheet";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { StatCard } from "@/components/ui/StatCard";
import { money, shortDate } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/** Arabic labels + badge variant per PO status, matching the web's Badge use. */
const STATUS = (): Record<string, { label: string; variant: "accent" | "success" | "lowstock" | "neutral" }> => ({
  draft: { label: t("app.purchasesStatus.draft"), variant: "neutral" },
  ordered: { label: t("mobile.purchases.ordered"), variant: "accent" },
  received: { label: t("app.purchasesStatus.received"), variant: "success" },
  cancelled: { label: t("app.purchasesStatus.cancelled"), variant: "lowstock" },
});

type Filter = "all" | "draft" | "received" | "cancelled";
const FILTERS = (): { key: Filter; label: string }[] => [
  { key: "all", label: t("app.purchases.filters.all") },
  { key: "draft", label: t("app.purchases.filters.drafts") },
  { key: "received", label: t("app.purchases.filters.received") },
  { key: "cancelled", label: t("app.purchases.filters.cancelled") },
];

type Action = "receive" | "cancel" | "delete";

/**
 * Port of app__purchases.png — PO cards with totals and payment state (doc 02
 * §1.1 row 7, RECOMPOSE). The builder is the split-out PoBuilderSheet; the
 * receive / cancel / delete actions are the web's exactly: whole-order
 * receive with updateCost:true behind a confirm, and all three offered only
 * on drafts (the web's `o.status === "draft"` block — the server would also
 * delete a cancelled order, but the page being ported does not offer it).
 * Everything that writes is gated on `manage_purchases`, the way the web's
 * `can(principal, "manage_purchases")` hides its buttons.
 */
/** Arabic counts 1 / 2 / 3–10 / 11+ differently; the dictionary carries One/Two/Few beside the default. */
function countForm(n: number): string {
  return n === 1 ? "One" : n === 2 ? "Two" : n >= 3 && n <= 10 ? "Few" : "";
}

export default function PurchasesScreen() {
  const qc = useQueryClient();
  const me = useSession((s) => s.me);
  const perms = new Set(me?.permissions ?? []);
  // The web's can(): owners bypass, staff need the permission.
  const canManage = !!me && (me.isOwner || perms.has("manage_purchases"));
  // POST /api/suppliers is gated on manage_suppliers, not on manage_purchases;
  // the builder hides its inline "new supplier" otherwise.
  const canCreateSupplier = !!me && (me.isOwner || perms.has("manage_suppliers"));

  const pos = useQuery({
    queryKey: ["purchase-orders"],
    queryFn: () => catalog.listPurchaseOrders(api),
  });

  const [filter, setFilter] = useState<Filter>("all");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "success" | "error" } | null>(null);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(id);
  }, [notice]);

  const act = useMutation({
    mutationFn: ({ kind, id }: { kind: Action; id: string }) =>
      kind === "receive"
        ? catalog.receivePurchaseOrder(api, id, { updateCost: true })
        : kind === "cancel"
          ? catalog.cancelPurchaseOrder(api, id)
          : catalog.deletePurchaseOrder(api, id),
    onSuccess: (_res, { kind }) => {
      setNotice({
        text: t(
          kind === "receive"
            ? "app.purchases.toast.receiveSuccess"
            : kind === "cancel"
              ? "app.purchases.toast.cancelSuccess"
              : "app.purchases.toast.deleteSuccess",
        ),
        tone: "success",
      });
      void qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      void qc.invalidateQueries({ queryKey: ["suppliers"] });
      if (kind === "receive") void qc.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (e, { kind }) => {
      const fallback = t(
        kind === "receive"
          ? "app.purchases.toast.receiveFailed"
          : kind === "cancel"
            ? "app.purchases.toast.cancelFailed"
            : "app.purchases.toast.deleteFailed",
      );
      setNotice({ text: describeError(e, fallback), tone: "error" });
    },
    // "Receive now" runs this while the builder is still on its done step (see
    // PoBuilderSheet's onReceiveNow); either outcome lands the user back on
    // the list, where the notice above is visible. A no-op from the rows.
    onSettled: () => setBuilderOpen(false),
  });

  /** The web's ConfirmDialog, as the native alert; same title/message/confirm strings. */
  const confirm = (kind: Action, id: string) => {
    Alert.alert(
      t(`app.purchases.actions.${kind}.title`),
      t(`app.purchases.actions.${kind}.message`),
      [
        { text: t("app.purchases.builder.cancel"), style: "cancel" },
        {
          text: t(`app.purchases.actions.${kind}.confirm`),
          style: kind === "receive" ? "default" : "destructive",
          onPress: () => act.mutate({ kind, id }),
        },
      ],
    );
  };

  const orders = pos.data ?? [];
  const shown = useMemo(
    () => (filter === "all" ? orders : orders.filter((o) => o.status === filter)),
    [orders, filter],
  );

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

      {canManage ? (
        <View testID="po-new-order">
          <Button label={t("app.purchases.newOrder")} onPress={() => setBuilderOpen(true)} />
        </View>
      ) : null}

      {notice ? (
        <View style={[styles.notice, notice.tone === "error" ? styles.noticeError : styles.noticeSuccess]}>
          <Text style={[styles.noticeText, notice.tone === "error" ? styles.noticeTextError : styles.noticeTextSuccess]}>
            {notice.text}
          </Text>
        </View>
      ) : null}

      <PoBuilderSheet
        visible={builderOpen}
        canCreateSupplier={canCreateSupplier}
        onClose={() => setBuilderOpen(false)}
        onCreated={() => void qc.invalidateQueries({ queryKey: ["purchase-orders"] })}
        onReceiveNow={(id) => confirm("receive", id)}
        receiving={act.isPending && act.variables?.kind === "receive"}
      />

      <Segmented items={FILTERS()} value={filter} onChange={setFilter} />

      {pos.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : pos.isError ? (
        <EmptyState title={describeError(pos.error, t("mobile.common.serverError"))} />
      ) : shown.length === 0 ? (
        <EmptyState
          title={orders.length === 0 ? t("mobile.purchases.empty") : t("app.purchases.emptyFiltered")}
          hint={orders.length === 0 ? t("mobile.purchases.emptyHint") : undefined}
        />
      ) : (
        <View style={styles.list}>
          {shown.map((o) => {
            const s = STATUS()[o.status] ?? { label: o.status, variant: "neutral" as const };
            const due = o.total - o.paidAmount;
            const busy = act.isPending && act.variables?.id === o.id;
            return (
              <View key={o.id} style={styles.row} testID="po-row">
                <View style={styles.rowHead}>
                  <Text numberOfLines={1} style={styles.supplier} testID="po-row-supplier">
                    {o.supplierName}
                  </Text>
                  <Badge label={s.label} variant={s.variant} />
                </View>
                <View style={styles.rowMeta}>
                  <Text style={styles.total} testID="po-row-total">{money(o.total)}</Text>
                  <Text style={styles.meta} testID="po-row-meta">
                    {t(`mobile.purchases.orderMeta${countForm(o.itemCount)}`, { n: o.itemCount, date: shortDate(o.orderDate) })}
                  </Text>
                </View>
                {o.status === "received" && o.receivedDate ? (
                  <Text style={styles.meta}>{t("app.purchases.row.received", { date: shortDate(o.receivedDate) })}</Text>
                ) : null}
                {o.status === "received" && due > 0 ? (
                  <Text style={styles.due}>{t("mobile.purchases.remaining", { amount: money(due) })}</Text>
                ) : null}
                {o.notes ? <Text numberOfLines={2} style={styles.meta}>{o.notes}</Text> : null}

                {canManage && o.status === "draft" ? (
                  <View style={styles.actions}>
                    <Button
                      label={t("app.purchases.row.receive")}
                      onPress={() => confirm("receive", o.id)}
                      disabled={busy}
                      loading={busy && act.variables?.kind === "receive"}
                      style={styles.actionBtn}
                    />
                    <Button
                      label={t("app.purchases.row.cancel")}
                      variant="outline"
                      onPress={() => confirm("cancel", o.id)}
                      disabled={busy}
                      style={styles.actionBtn}
                    />
                    <Pressable
                      onPress={() => confirm("delete", o.id)}
                      disabled={busy}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={t("app.purchases.row.deleteTitle")}
                      style={styles.iconBtn}
                    >
                      <Trash size={20} color={colors.danger} />
                    </Pressable>
                  </View>
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
  // Same box as a StatCard (padding + border) so Yoga's flex basis matches and
  // the orphan tile is exactly as wide as the two above it.
  spacer: { flex: 1, padding: spacing.lg, borderWidth: 1, borderColor: "transparent" },
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
  supplier: { flex: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  total: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 16, color: colors.text, fontVariant: ["tabular-nums"] },
  meta: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  due: { fontFamily: fonts.medium, fontSize: 13, color: colors.danger, ...RTL_TEXT },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  actionBtn: { flex: 1 },
  iconBtn: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center" },
  notice: { padding: spacing.md, borderRadius: radius.md, borderWidth: 1 },
  noticeSuccess: { backgroundColor: colors.successLight, borderColor: colors.success },
  noticeError: { backgroundColor: colors.dangerLight, borderColor: colors.danger },
  noticeText: { fontFamily: fonts.medium, fontSize: 13, ...RTL_TEXT },
  noticeTextSuccess: { color: colors.successStrong },
  noticeTextError: { color: colors.danger },
});
