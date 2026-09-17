import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Minus, Plus, Trash } from "phosphor-react-native";
import { ApiError, catalog, sales as salesApi } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { Field } from "@/components/ui/Field";
import { SearchField } from "@/components/ui/SearchField";
import { money } from "@/lib/format";
import { selectItemCount, selectTotals, useCart } from "@/stores/cart";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

type Payment = salesApi.PaymentMethod;

/** dictionaries/ar.json — the four methods the cart route accepts. */
const PAYMENTS: { key: Payment; label: string }[] = [
  { key: "cash", label: "كاش" },
  { key: "instapay", label: "إنستا باي" },
  { key: "card", label: "بطاقة" },
  { key: "deferred", label: "آجل" },
];

/**
 * The POS — app__sales-pos.png, recomposed per doc 04: the sale comes first,
 * because a cashier opens this screen to take money.
 *
 *   search / recent → tap to add → cart with ± → payment → تسجيل الفاتورة
 *
 * Totals are computed by @matgary/domain's computeCartTotals, the same
 * function the web's SaleForm uses and the server mirrors. The invoice id is
 * minted client-side and doubles as the Idempotency-Key, so a retry after a
 * dropped connection returns the original sale rather than booking a second.
 *
 * The camera scanner is phase 2 — it needs expo-camera, which Expo Go does not
 * carry for this app. The barcode glyph on the search field is where it lands.
 */
export default function SalesScreen() {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [payment, setPayment] = useState<Payment>("cash");
  const [lastSale, setLastSale] = useState<salesApi.CartSaleResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cart = useCart();
  const totals = useCart(selectTotals);
  const itemCount = useCart(selectItemCount);

  const products = useQuery({
    queryKey: ["products"],
    queryFn: () => catalog.listProducts(api),
  });
  const recentSales = useQuery({
    queryKey: ["sales"],
    queryFn: () => catalog.listSales(api),
  });

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
  const recent = useMemo(() => {
    const byId = new Map((products.data ?? []).map((p) => [p.id, p]));
    const seen = new Set<string>();
    const out = [];
    for (const l of recentSales.data ?? []) {
      if (seen.has(l.productId)) continue;
      const p = byId.get(l.productId);
      if (!p) continue;
      seen.add(l.productId);
      out.push(p);
      if (out.length >= 5) break;
    }
    return out;
  }, [products.data, recentSales.data]);

  const checkout = useMutation({
    mutationFn: () =>
      salesApi.recordCartSale(
        api,
        cart.lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          pricePerUnit: l.pricePerUnit,
          ...(l.lineDiscountValue > 0
            ? { lineDiscountType: l.lineDiscountType, lineDiscountValue: l.lineDiscountValue }
            : {}),
        })),
        {
          paymentMethod: payment,
          invoiceId: cart.invoiceId,
          ...(cart.customerName.trim() ? { customerName: cart.customerName.trim() } : {}),
          ...(cart.customerPhone.trim() ? { customerPhone: cart.customerPhone.trim() } : {}),
          ...(cart.note.trim() ? { note: cart.note.trim() } : {}),
          ...(cart.orderDiscountValue > 0
            ? { orderDiscountType: cart.orderDiscountType, orderDiscountValue: cart.orderDiscountValue }
            : {}),
        },
        cart.invoiceId,
      ),
    onSuccess: (result) => {
      setLastSale(result);
      setError(null);
      cart.reset();
      setQuery("");
      // Stock moved and the dashboard's numbers are stale — everything that
      // reads either must refetch.
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["sales"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      void qc.invalidateQueries({ queryKey: ["insights-overview"] });
    },
    onError: (e) => setError(messageFor(e)),
  });

  const canCheckout = cart.lines.length > 0 && !checkout.isPending;

  return (
    <Screen
      onRefresh={() => void products.refetch()}
      refreshing={products.isRefetching}
    >
      {lastSale ? (
        <Card>
          <View style={styles.successHead}>
            <CheckCircle size={28} color={colors.success} weight="fill" />
            <Text style={styles.successTitle}>تم تسجيل البيع بنجاح</Text>
          </View>
          <Text style={styles.successInvoice}>{lastSale.invoiceId}</Text>
          <View style={styles.receipt}>
            {lastSale.lines.map((l) => (
              <View key={l.productId} style={styles.receiptRow}>
                <Text numberOfLines={1} style={styles.receiptName}>
                  {l.productName} ×{l.quantity}
                </Text>
                <Text style={styles.receiptAmt}>{money(l.lineTotal)}</Text>
              </View>
            ))}
            <View style={[styles.receiptRow, styles.receiptTotal]}>
              <Text style={styles.receiptTotalLabel}>الإجمالي</Text>
              <Text style={styles.receiptTotalAmt}>{money(lastSale.total)}</Text>
            </View>
          </View>
          <Button label="بيع جديد" onPress={() => setLastSale(null)} />
        </Card>
      ) : null}

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
              {matches.map((p) => {
                const out = p.quantity <= 0;
                return (
                  <Pressable
                    key={p.id}
                    style={[styles.result, out && styles.resultOut]}
                    disabled={out}
                    onPress={() => {
                      cart.add(p);
                      setQuery("");
                    }}
                    accessibilityRole="button"
                  >
                    <View style={styles.resultText}>
                      <Text numberOfLines={1} style={styles.resultName}>
                        {p.name}
                      </Text>
                      <Text style={styles.resultStock}>
                        {out ? "غير متوفر" : `المتاح: ${p.quantity} قطعة`}
                      </Text>
                    </View>
                    <Text style={styles.resultPrice}>{money(p.price)}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <Text style={styles.muted}>لا يوجد منتج بهذا الاسم — أضفه للمخزن</Text>
          )
        ) : recent.length ? (
          <>
            <Text style={styles.label}>منتجات حديثة:</Text>
            <View style={styles.pillRow}>
              {recent.map((p) => (
                <Pressable
                  key={p.id}
                  style={styles.pill}
                  onPress={() => cart.add(p)}
                  accessibilityRole="button"
                >
                  <Text numberOfLines={1} style={styles.pillText}>
                    {p.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
      </Card>

      {cart.lines.length > 0 ? (
        <Card title={`${itemCount} منتج في الفاتورة`}>
          <View style={styles.cartList}>
            {cart.lines.map((l) => (
              <View key={l.productId} style={styles.cartRow}>
                <View style={styles.cartText}>
                  <Text numberOfLines={1} style={styles.cartName}>
                    {l.name}
                  </Text>
                  <Text style={styles.cartUnit}>
                    {money(l.pricePerUnit)} × {l.quantity}
                  </Text>
                </View>
                <View style={styles.qty}>
                  <Pressable
                    style={styles.qtyBtn}
                    onPress={() => cart.setQuantity(l.productId, l.quantity - 1)}
                    accessibilityRole="button"
                    accessibilityLabel="تقليل الكمية"
                  >
                    <Minus size={16} color={colors.accent} weight="bold" />
                  </Pressable>
                  <Text style={styles.qtyValue}>{l.quantity}</Text>
                  <Pressable
                    style={[styles.qtyBtn, l.quantity >= l.available && styles.qtyBtnDisabled]}
                    disabled={l.quantity >= l.available}
                    onPress={() => cart.setQuantity(l.productId, l.quantity + 1)}
                    accessibilityRole="button"
                    accessibilityLabel="زيادة الكمية"
                  >
                    <Plus size={16} color={colors.accent} weight="bold" />
                  </Pressable>
                </View>
                <Text style={styles.cartTotal}>{money(l.quantity * l.pricePerUnit)}</Text>
                <Pressable
                  onPress={() => cart.remove(l.productId)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="حذف"
                >
                  <Trash size={18} color={colors.textSecondary} />
                </Pressable>
              </View>
            ))}
          </View>

          <View style={styles.totals}>
            <TotalRow label="المجموع الفرعي" value={money(totals.subtotalGross)} />
            {totals.lineDiscountTotal > 0 ? (
              <TotalRow label="خصومات بنود" value={`- ${money(totals.lineDiscountTotal)}`} />
            ) : null}
            {totals.orderDiscount > 0 ? (
              <TotalRow label="خصم الفاتورة" value={`- ${money(totals.orderDiscount)}`} />
            ) : null}
            <TotalRow label="الإجمالي" value={money(totals.afterOrderDiscount)} strong />
          </View>

          <Text style={styles.label}>طريقة الدفع</Text>
          <View style={styles.pillRow}>
            {PAYMENTS.map((p) => (
              <Chip
                key={p.key}
                label={p.label}
                active={payment === p.key}
                onPress={() => setPayment(p.key)}
              />
            ))}
          </View>
          {payment === "deferred" ? (
            <Text style={styles.muted}>
              هتتسجل الفاتورة على حساب العميل. تقدر تاخد جزء دلوقتي والباقي بعدين.
            </Text>
          ) : null}

          <View style={styles.customer}>
            <Field
              label="اسم العميل (اختياري)"
              value={cart.customerName}
              onChangeText={(v) => cart.setCustomer(v, cart.customerPhone)}
            />
            <Field
              label="رقم الموبايل"
              value={cart.customerPhone}
              onChangeText={(v) => cart.setCustomer(cart.customerName, v)}
              keyboardType="phone-pad"
              placeholder="01xxxxxxxxx"
            />
          </View>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Button
            label="تسجيل الفاتورة"
            loading={checkout.isPending}
            disabled={!canCheckout}
            onPress={() => checkout.mutate()}
          />
        </Card>
      ) : null}

      {products.isLoading ? <ActivityIndicator color={colors.accent} /> : null}
    </Screen>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.totalRow}>
      <Text style={[styles.totalLabel, strong && styles.totalStrong]}>{label}</Text>
      <Text numberOfLines={1} style={[styles.totalValue, strong && styles.totalStrong]}>
        {value}
      </Text>
    </View>
  );
}

/**
 * The cart route answers three ways: a machine code (INSUFFICIENT_STOCK), a
 * raw English zod message on 400, or Arabic prose. Only the first is safe to
 * map; the rest fall to a generic line rather than showing an Arabic-speaking
 * shopkeeper "Expected number, received string".
 */
function messageFor(e: unknown): string {
  if (!(e instanceof ApiError)) return "تعذّر تسجيل البيع";
  switch (e.code) {
    case "INSUFFICIENT_STOCK":
      return "الكمية المطلوبة غير متوفرة في المخزن";
    case "PRODUCT_NOT_FOUND":
      return "أحد المنتجات لم يعد موجوداً";
    case "PRODUCT_WRONG_BRANCH":
      return "هذا المنتج يخص فرعاً آخر";
    case "CART_EMPTY":
      return "الفاتورة فارغة";
  }
  switch (e.kind) {
    case "offline":
      return "تعذّر الاتصال بالخادم — لم يُسجَّل البيع";
    case "timeout":
      return "انتهت مهلة الاتصال — لم يُسجَّل البيع";
    case "rateLimited":
      return "محاولات كثيرة. انتظر قليلاً";
    case "forbidden":
      return "ليست لديك صلاحية تسجيل البيع";
    default:
      return "تعذّر تسجيل البيع";
  }
}

const styles = StyleSheet.create({
  label: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, marginBottom: spacing.sm, ...RTL_TEXT },
  muted: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, marginTop: spacing.sm, ...RTL_TEXT },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.sm },
  pill: { backgroundColor: colors.accentLight, borderRadius: radius.full, paddingHorizontal: spacing.lg, minHeight: 44, justifyContent: "center", flexShrink: 1 },
  pillText: { fontFamily: fonts.medium, fontSize: 14, color: colors.accent },
  results: { marginTop: spacing.md, gap: spacing.sm },
  result: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, minHeight: 56, paddingHorizontal: spacing.lg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  resultOut: { opacity: 0.45 },
  resultText: { flexShrink: 1, minWidth: 0 },
  resultName: { fontFamily: fonts.medium, fontSize: 15, color: colors.text, ...RTL_TEXT },
  resultStock: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  resultPrice: { fontFamily: fonts.bold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"], flexShrink: 0 },
  cartList: { gap: spacing.sm },
  cartRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  cartText: { flex: 1, minWidth: 0 },
  cartName: { fontFamily: fonts.medium, fontSize: 14, color: colors.text, ...RTL_TEXT },
  cartUnit: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  qty: { flexDirection: "row", alignItems: "center", gap: 4 },
  qtyBtn: { width: 36, height: 36, borderRadius: radius.md, borderWidth: 1, borderColor: colors.accent, alignItems: "center", justifyContent: "center" },
  qtyBtnDisabled: { opacity: 0.35 },
  qtyValue: { minWidth: 28, textAlign: "center", fontFamily: fonts.bold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"] },
  cartTotal: { minWidth: 80, fontFamily: fonts.bold, fontSize: 14, color: colors.text, fontVariant: ["tabular-nums"], ...RTL_TEXT },
  totals: { marginTop: spacing.lg, marginBottom: spacing.lg, gap: 6 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.md },
  totalLabel: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
  totalValue: { fontFamily: fonts.medium, fontSize: 14, color: colors.text, fontVariant: ["tabular-nums"] },
  totalStrong: { fontFamily: fonts.bold, fontSize: 18, color: colors.text },
  customer: { gap: spacing.md, marginTop: spacing.sm, marginBottom: spacing.lg },
  errorBox: { backgroundColor: colors.dangerLight, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  errorText: { fontFamily: fonts.medium, fontSize: 14, color: colors.danger, textAlign: "center" },
  successHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: 4 },
  successTitle: { fontFamily: fonts.bold, fontSize: 18, color: colors.successStrong, ...RTL_TEXT },
  successInvoice: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, marginBottom: spacing.md, ...RTL_TEXT },
  receipt: { gap: 6, marginBottom: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  receiptRow: { flexDirection: "row", justifyContent: "space-between", gap: spacing.md },
  receiptName: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 14, color: colors.text, ...RTL_TEXT },
  receiptAmt: { fontFamily: fonts.medium, fontSize: 14, color: colors.text, fontVariant: ["tabular-nums"] },
  receiptTotal: { marginTop: 4, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  receiptTotalLabel: { fontFamily: fonts.bold, fontSize: 16, color: colors.text },
  receiptTotalAmt: { fontFamily: fonts.bold, fontSize: 18, color: colors.text, fontVariant: ["tabular-nums"] },
});
