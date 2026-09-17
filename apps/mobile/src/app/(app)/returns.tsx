import { useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { isRTL } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { money, shortDate } from "@/lib/format";
import { RTL_TEXT, directionStyle } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Port of app__returns.png.
 *
 * HANDOFF open item 8: on the web a return is actually TAKEN from an invoice
 * row on /sales, not from here — this page only lists them. Doc 04 marks it
 * RECOMPOSE (scan-first) to fix that. Listing is what the capture shows, so
 * that is what this ports; the scan-to-return flow is phase 2.
 */
export default function ReturnsScreen() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["returns"], queryFn: () => catalog.listReturns(api) });
  const sales = useQuery({ queryKey: ["sales"], queryFn: () => catalog.listSales(api) });

  const [open, setOpen] = useState(false);
  const [line, setLine] = useState<{ id: string; productId: string; productName: string; quantitySold: number } | null>(null);
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      catalog.createReturn(api, {
        saleId: line!.id,
        productId: line!.productId,
        returnedQuantity: Number(qty),
        reason: reason.trim(),
      }),
    onSuccess: () => {
      setOpen(false); setLine(null); setQty("1"); setReason(""); setError(null);
      void qc.invalidateQueries({ queryKey: ["returns"] });
      void qc.invalidateQueries({ queryKey: ["sales"] });
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => setError(e instanceof ApiError && e.kind === "offline" ? "تعذّر الاتصال بالخادم" : "تعذّر تسجيل المرتجع"),
  });

  const n = Number(qty);
  const canSubmit = line !== null && Number.isInteger(n) && n >= 1 && n <= (line?.quantitySold ?? 0) && reason.trim().length > 0 && !create.isPending;

  const rows = q.data ?? [];
  const total = rows.reduce((s, r) => s + (r.amount ?? 0), 0);

  return (
    <Screen
      title="المرتجعات"
      subtitle={rows.length ? `${rows.length} مرتجع · ${money(total)}` : undefined}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      <Button label="تسجيل مرتجع" onPress={() => setOpen(true)} />

      {/* HANDOFF item 8: on the web a return is taken from /sales, not here.
          Doc 04 wanted this screen scan-first; until the scanner lands, the
          cashier picks the sale line from the recent list. */}
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={[styles.modal, directionStyle(isRTL())]}>
          <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>تسجيل مرتجع</Text>
            {!line ? (
              <>
                <Text style={styles.meta}>اختر البند من آخر المبيعات:</Text>
                {(sales.data ?? []).slice(0, 30).map((l) => (
                  <Pressable key={l.id} style={styles.pick} onPress={() => { setLine(l); setQty("1"); }}>
                    <Text numberOfLines={1} style={styles.pickName}>{l.productName}</Text>
                    <Text style={styles.meta}>{l.invoiceId} · {l.quantitySold} قطعة</Text>
                  </Pressable>
                ))}
              </>
            ) : (
              <>
                <Pressable onPress={() => setLine(null)}><Text style={styles.link}>‹ تغيير البند</Text></Pressable>
                <Text style={styles.pickName}>{line.productName}</Text>
                <Text style={styles.meta}>الحد الأقصى: {line.quantitySold}</Text>
                <Field label="الكمية المرتجعة" value={qty} onChangeText={setQty} keyboardType="number-pad" />
                <Field label="السبب" value={reason} onChangeText={setReason} placeholder="مثال: عيب في المنتج" />
                {error ? <Text style={styles.err}>{error}</Text> : null}
                <Button label="تسجيل المرتجع" disabled={!canSubmit} loading={create.isPending} onPress={() => create.mutate()} />
              </>
            )}
            <Button label="إلغاء" variant="ghost" onPress={() => { setOpen(false); setLine(null); }} />
          </ScrollView>
        </View>
      </Modal>

      {q.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="لا توجد مرتجعات"
          hint="المرتجع يُسجَّل من فاتورة البيع في شاشة المبيعات."
        />
      ) : (
        <View style={styles.list}>
          {rows.map((r, i) => (
            <View key={r.id ?? String(i)} style={styles.row}>
              <View style={styles.head}>
                <Text numberOfLines={1} style={styles.name}>
                  {r.productName ?? r.invoiceId ?? "مرتجع"}
                </Text>
                <Text style={styles.amount}>{money(r.amount ?? 0)}</Text>
              </View>
              <Text style={styles.meta}>
                {r.quantity ? `${r.quantity} قطعة · ` : ""}
                {shortDate(r.returnDate)}
              </Text>
              {r.reason ? (
                <Text numberOfLines={2} style={styles.meta}>
                  {r.reason}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
  row: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: 4,
    ...elevation.card,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  name: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  amount: { fontFamily: fonts.bold, fontSize: 15, color: colors.danger, fontVariant: ["tabular-nums"] },
  meta: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  modal: { flex: 1, backgroundColor: colors.bg },
  modalContent: { padding: spacing.xl, paddingTop: 60, gap: spacing.md },
  modalTitle: { fontFamily: fonts.bold, fontSize: 24, color: colors.text, ...RTL_TEXT },
  pick: { padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, gap: 2 },
  pickName: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  link: { fontFamily: fonts.medium, fontSize: 14, color: colors.accent, ...RTL_TEXT },
  err: { fontFamily: fonts.medium, fontSize: 14, color: colors.danger, textAlign: "center" },
});
