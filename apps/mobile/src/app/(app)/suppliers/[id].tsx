import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { At, MapPin, Phone, Receipt, Truck, Wallet } from "phosphor-react-native";
import { ApiError, catalog, type Expense, type PurchaseOrder, type Supplier } from "@matgary/api-client";

import { api } from "@/api/client";
import { isRTL, t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { ChevronBack } from "@/components/ui/Chevron";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { money, shortDate } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL_TEXT, directionStyle } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Port of app__supplier-detail.png (/suppliers/<id>).
 *
 * Reads the capture top to bottom: breadcrumb, header card (avatar → name →
 * phone/address → تعديل), the three stacked figures (المستحق الحالي, إجمالي
 * المشتريات, إجمالي المدفوعات), then أوامر الشراء and المدفوعات.
 *
 * The two totals are derived exactly as the web derives them
 * (apps/web/app/suppliers/[id]/page.tsx): purchases counts RECEIVED orders
 * only, payments are the linked expense rows. `supplier.balance` is the
 * running column and is shown as-is.
 */

const STATUS: Record<
  string,
  { label: string; variant: "success" | "lowstock" | "neutral" | "accent" }
> = {
  // The capture shows مسودة in orange, تم الاستلام green, ملغي grey — the web's
  // STATUS_STYLES, not the purchases-list mapping (which greys out مسودة).
  draft: { label: t("app.purchasesStatus.draft"), variant: "lowstock" },
  ordered: { label: t("mobile.purchases.ordered"), variant: "accent" },
  received: { label: t("app.purchasesStatus.received"), variant: "success" },
  cancelled: { label: t("app.purchasesStatus.cancelled"), variant: "neutral" },
};

export default function SupplierDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string | string[] }>();
  const id = (Array.isArray(params.id) ? params.id[0] : params.id) ?? "";

  const queryClient = useQueryClient();
  const permissions = useSession((s) => s.me?.permissions);
  const canManage = new Set(permissions ?? []).has("manage_suppliers");

  const [editOpen, setEditOpen] = useState(false);

  const supplierQ = useQuery({
    queryKey: ["supplier", id],
    enabled: id.length > 0,
    queryFn: async () => {
      try {
        return (
          await api.request<{ data: Supplier }>(
            `/api/suppliers/${encodeURIComponent(id)}`,
          )
        ).data;
      } catch (error) {
        if (error instanceof ApiError && error.kind === "notFound") return null;
        throw error;
      }
    },
  });

  // Both of these 403 for a user without view_purchases / view_expenses. That
  // is not an error state for this screen — the section just stays empty,
  // which is what the web shows such a user too.
  const ordersQ = useQuery({
    queryKey: ["purchase-orders", { supplierId: id }],
    enabled: id.length > 0,
    queryFn: async () => {
      try {
        const res = await api.request<{ data: PurchaseOrder[] }>(
          "/api/purchase-orders",
          { query: { supplierId: id } },
        );
        return res.data ?? [];
      } catch (error) {
        if (error instanceof ApiError && error.kind === "forbidden") return [];
        throw error;
      }
    },
  });

  const expensesQ = useQuery({
    queryKey: ["expenses"],
    queryFn: async () => {
      try {
        return await catalog.listExpenses(api);
      } catch (error) {
        if (error instanceof ApiError && error.kind === "forbidden") {
          return [] as Expense[];
        }
        throw error;
      }
    },
  });

  const orders = ordersQ.data ?? [];

  const payments = useMemo(
    () =>
      (expensesQ.data ?? [])
        .filter((e) => e.supplierId === id)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    [expensesQ.data, id],
  );

  const totalReceived = useMemo(
    () =>
      orders
        .filter((o) => o.status === "received")
        .reduce((sum, o) => sum + o.total, 0),
    [orders],
  );
  const totalPaid = useMemo(
    () => payments.reduce((sum, e) => sum + e.amount, 0),
    [payments],
  );

  const supplier = supplierQ.data ?? null;

  const refresh = () => {
    void supplierQ.refetch();
    void ordersQ.refetch();
    void expensesQ.refetch();
  };

  return (
    <Screen onRefresh={refresh} refreshing={supplierQ.isRefetching}>
      <View style={styles.crumb}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("app.suppliers.detail.backToList")}
          hitSlop={8}
          style={styles.crumbLink}
          onPress={() => router.navigate("/suppliers")}
        >
          <Text style={styles.crumbText}>{t("app.suppliers.title")}</Text>
        </Pressable>
        <ChevronBack size={14} color={colors.textSecondary} />
        <Text numberOfLines={1} style={styles.crumbCurrent}>
          {supplier?.name ?? ""}
        </Text>
      </View>

      {supplierQ.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : !supplier ? (
        <Card>
          <Text style={styles.notFound}>{t("app.suppliers.detail.notFound")}</Text>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            style={styles.backLink}
            onPress={() => router.navigate("/suppliers")}
          >
            <Text style={styles.backLinkText}>{t("app.suppliers.detail.backToList")}</Text>
          </Pressable>
        </Card>
      ) : (
        <>
          <Card>
            <View style={styles.avatar}>
              <Truck size={28} color={colors.accent} />
            </View>
            <Text style={styles.name}>{supplier.name}</Text>
            <View style={styles.metaRow}>
              {supplier.phone ? (
                <View style={styles.metaItem}>
                  <Phone size={14} color={colors.textSecondary} />
                  <Text numberOfLines={1} style={styles.meta}>
                    {supplier.phone}
                  </Text>
                </View>
              ) : null}
              {supplier.email ? (
                <View style={styles.metaItem}>
                  <At size={14} color={colors.textSecondary} />
                  <Text numberOfLines={1} style={styles.meta}>
                    {supplier.email}
                  </Text>
                </View>
              ) : null}
              {supplier.address ? (
                <View style={styles.metaItem}>
                  <MapPin size={14} color={colors.textSecondary} />
                  <Text numberOfLines={1} style={[styles.meta, RTL_TEXT]}>
                    {supplier.address}
                  </Text>
                </View>
              ) : null}
            </View>
            {canManage ? (
              <Button
                label={t("app.common.edit")}
                variant="outline"
                style={styles.editButton}
                onPress={() => setEditOpen(true)}
              />
            ) : null}
          </Card>

          <Figure
            label={t("app.suppliers.detail.stats.balance")}
            value={money(supplier.balance)}
            tone={supplier.balance > 0 ? "danger" : "default"}
          />
          <Figure label={t("app.purchases.kpi.totalPurchases")} value={money(totalReceived)} />
          <Figure label={t("app.suppliers.detail.stats.totalPayments")} value={money(totalPaid)} tone="success" />

          {supplier.notes ? (
            <Card>
              <Text style={styles.figureLabel}>{t("app.common.notes")}</Text>
              <Text style={styles.notes}>{supplier.notes}</Text>
            </Card>
          ) : null}

          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Receipt size={20} color={colors.text} />
              <Text style={styles.sectionTitle}>{t("app.suppliers.detail.purchaseOrders")}</Text>
            </View>
            {ordersQ.isLoading ? (
              <ActivityIndicator color={colors.accent} />
            ) : orders.length === 0 ? (
              <Text style={styles.sectionEmpty}>{t("app.suppliers.detail.purchaseOrdersEmpty")}</Text>
            ) : (
              <View style={styles.rows}>
                {orders.slice(0, 10).map((o, index) => {
                  const s = STATUS[o.status] ?? {
                    label: o.status,
                    variant: "neutral" as const,
                  };
                  return (
                    <View
                      key={o.id}
                      style={[styles.row, index > 0 && styles.rowDivided]}
                    >
                      <View style={styles.rowMain}>
                        <View style={styles.rowTitleLine}>
                          <Text numberOfLines={1} style={styles.rowTitle}>
                            {t("mobile.purchases.itemCount", { n: o.itemCount })}
                          </Text>
                          <Badge label={s.label} variant={s.variant} />
                        </View>
                        <Text style={styles.rowDate}>{shortDate(o.orderDate)}</Text>
                      </View>
                      <Text numberOfLines={1} style={styles.rowAmount}>
                        {money(o.total)}
                      </Text>
                    </View>
                  );
                })}
              </View>
            )}
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Wallet size={20} color={colors.text} />
              <Text style={styles.sectionTitle}>{t("app.suppliers.detail.payments")}</Text>
            </View>
            {expensesQ.isLoading ? (
              <ActivityIndicator color={colors.accent} />
            ) : payments.length === 0 ? (
              <Text style={styles.sectionEmpty}>
                {t("app.suppliers.detail.paymentsEmpty")}
              </Text>
            ) : (
              <View style={styles.rows}>
                {payments.slice(0, 10).map((e, index) => (
                  <View
                    key={e.id}
                    style={[styles.row, index > 0 && styles.rowDivided]}
                  >
                    <View style={styles.rowMain}>
                      <Text numberOfLines={1} style={styles.rowTitle}>
                        {e.title}
                      </Text>
                      <Text style={styles.rowDate}>{shortDate(e.date)}</Text>
                    </View>
                    <Text numberOfLines={1} style={styles.rowAmountPaid}>
                      {money(e.amount)}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* Mounted only while open so every open seeds the inputs from the
              freshly fetched row instead of whatever was typed last time. */}
          {editOpen ? (
            <EditSupplierModal
              supplier={supplier}
              onClose={() => setEditOpen(false)}
              onSaved={async () => {
                setEditOpen(false);
                await supplierQ.refetch();
                // The list screen reads the same rows.
                void queryClient.invalidateQueries({ queryKey: ["suppliers"] });
              }}
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}

/** One stacked figure card: small grey label, large value under it. */
function Figure({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "danger" | "success";
}) {
  return (
    <Card>
      <Text numberOfLines={1} style={styles.figureLabel}>
        {label}
      </Text>
      <Text
        numberOfLines={1}
        style={[
          styles.figureValue,
          tone === "danger" && styles.figureDanger,
          tone === "success" && styles.figureSuccess,
        ]}
      >
        {value}
      </Text>
    </Card>
  );
}

/**
 * The web's SupplierFormModal, reduced to what PATCH /api/suppliers/[id]
 * accepts. Empty inputs are sent as null rather than "" so a cleared field
 * really clears the column instead of storing a blank string.
 */
function EditSupplierModal({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: Supplier;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(supplier.name);
  const [phone, setPhone] = useState(supplier.phone ?? "");
  const [email, setEmail] = useState(supplier.email ?? "");
  const [address, setAddress] = useState(supplier.address ?? "");
  const [notes, setNotes] = useState(supplier.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError(t("mobile.suppliers.nameRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.request(`/api/suppliers/${encodeURIComponent(supplier.id)}`, {
        method: "PATCH",
        body: {
          name: name.trim(),
          phone: phone.trim() || null,
          email: email.trim() || null,
          address: address.trim() || null,
          notes: notes.trim() || null,
        },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("mobile.suppliers.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      visible
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={[styles.modalBackdrop, directionStyle(isRTL())]}>
        <View style={styles.modalSheet}>
          <ScrollView
            contentContainerStyle={styles.modalContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.modalTitle}>{t("mobile.suppliers.edit")}</Text>
            <Field label={t("app.inventory.bulkActions.supplierPlaceholder")} value={name} onChangeText={setName} />
            <Field
              label={t("app.suppliers.form.phone")}
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
            />
            <Field
              label={t("auth.forgot.emailLabel")}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <Field label={t("app.suppliers.form.address")} value={address} onChangeText={setAddress} />
            <Field label={t("app.common.notes")} value={notes} onChangeText={setNotes} multiline />
            {error ? <Text style={styles.modalError}>{error}</Text> : null}
            <Button label={t("app.common.save")} onPress={() => void submit()} loading={busy} />
            <Button label={t("app.common.cancel")} variant="ghost" onPress={onClose} disabled={busy} />
          </ScrollView>
        </View>
      </View>
    </Modal>
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
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: spacing.lg,
    rowGap: spacing.xs,
    marginTop: spacing.xs,
  },
  metaItem: { flexDirection: "row", alignItems: "center", gap: spacing.xs, flexShrink: 1 },
  meta: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
  editButton: { marginTop: spacing.lg },

  figureLabel: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  figureValue: {
    fontFamily: fonts.bold,
    fontSize: 24,
    color: colors.text,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
    ...RTL_TEXT,
  },
  figureDanger: { color: colors.danger },
  figureSuccess: { color: colors.successStrong },
  notes: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.text,
    marginTop: spacing.xs,
    ...RTL_TEXT,
  },

  section: { gap: spacing.md },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  sectionTitle: { fontFamily: fonts.bold, fontSize: 18, color: colors.text, ...RTL_TEXT },
  sectionEmpty: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },

  rows: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    ...elevation.card,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
  },
  rowDivided: { borderTopWidth: 1, borderTopColor: colors.border },
  rowMain: { flex: 1, minWidth: 0, gap: 2 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  rowTitle: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 15, color: colors.text, ...RTL_TEXT },
  rowDate: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  rowAmount: {
    flexShrink: 0,
    fontFamily: fonts.bold,
    fontSize: 16,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  rowAmountPaid: {
    flexShrink: 0,
    fontFamily: fonts.bold,
    fontSize: 16,
    color: colors.successStrong,
    fontVariant: ["tabular-nums"],
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    maxHeight: "88%",
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    ...elevation.modal,
  },
  modalContent: { padding: spacing.xl, gap: spacing.lg },
  modalTitle: { fontFamily: fonts.bold, fontSize: 20, color: colors.text, ...RTL_TEXT },
  modalError: { fontFamily: fonts.medium, fontSize: 13, color: colors.danger, ...RTL_TEXT },
});
