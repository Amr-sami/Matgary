import { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowUUpLeftIcon as ArrowUUpLeft } from "phosphor-react-native/src/icons/ArrowUUpLeft";
import { UserIcon as User } from "phosphor-react-native/src/icons/User";
import { ApiError, sales as salesApi } from "@matgary/api-client";

import { api } from "@/api/client";
import { isRTL, t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { ReceiptActions } from "@/components/receipt/ReceiptActions";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChevronBack, ChevronForward } from "@/components/ui/Chevron";
import { EmptyState } from "@/components/ui/EmptyState";
import { groupDigits, money, shortDate } from "@/lib/format";
import type { ReceiptSale } from "@/receipt/html";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Doc 02 §2.4 — one invoice: lines, totals, payment, customer, receipt.
 *
 * The route param is a sale LINE id (what GET /api/sales/[id] takes and what
 * the dashboard's recent-sales list pushes). The line tells us the invoice;
 * the invoice's lines come from the history screen's cache when we were
 * opened from there, else from `listInvoiceLines` (a deep link / notification).
 */

type Payment = salesApi.PaymentMethod;

const PAYMENT_LABELS = (): Record<Payment, string> => ({
  cash: t("app.activityLabels.paymentMethods.cash"),
  instapay: t("app.activityLabels.paymentMethods.instapay"),
  card: t("app.activityLabels.paymentMethods.card"),
  deferred: t("app.activityLabels.paymentMethods.deferred"),
});

/**
 * "−3,400 ج.م" with the sign at the READING start. A bare "−" + digits has no
 * strong character, so the paragraph fell back to the device direction and
 * in Arabic the sign landed at the visual left, detached from the digits
 * ("3,400 ج.م−" to the reader). A leading RLM/LRM pins the paragraph.
 */
function negative(value: number): string {
  return `${isRTL() ? "\u200F" : "\u200E"}−${money(value)}`;
}

function paymentLabel(p: Payment | null | undefined): string {
  return p ? PAYMENT_LABELS()[p] ?? p : "—";
}

/** LTR isolate (LRI U+2066 … PDI U+2069): keeps "date · time" and "+20…" in
 *  LTR order inside an Arabic paragraph (same helper as sales/history.tsx). */
function ltr(s: string): string {
  return `\u2066${s}\u2069`;
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toReceipt(inv: salesApi.Invoice): ReceiptSale {
  return {
    invoiceId: inv.invoiceId ?? inv.key,
    saleDate: new Date(inv.saleDate),
    lines: inv.lines.map((l) => ({
      productName: l.productName,
      brand: l.brand ?? null,
      quantity: l.quantitySold,
      pricePerUnit: l.pricePerUnit,
      subtotal: l.subtotal,
      // A row's discountAmount already carries its share of the order
      // discount, so the receipt shows it per line and no order-discount row.
      lineDiscountAmount: l.discountAmount ?? 0,
    })),
    cartSubtotal: inv.subtotal,
    orderDiscountAmount: 0,
    totalPrice: inv.total,
    amountPaid: inv.paymentMethod === "deferred" ? inv.amountPaid : undefined,
  };
}

export default function SaleDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const lineId = typeof id === "string" ? id : "";
  // POST /api/returns is gated on manage_returns (owners bypass) — same rule
  // as the returns screen, so the button never leads to a 403.
  const canReturn = useSession((s) =>
    Boolean(s.me && (s.me.isOwner || s.me.permissions?.includes("manage_returns"))),
  );
  const isOwner = useSession((s) => Boolean(s.me?.isOwner));

  const lineQ = useQuery({
    queryKey: ["sales", "line", lineId],
    enabled: lineId.length > 0,
    queryFn: () => salesApi.getSale(api, lineId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
  const line = lineQ.data;
  const invoiceKey = line ? line.invoiceId ?? line.id : null;

  const linesQ = useQuery({
    // Same key history.tsx primes with the lines it already grouped.
    queryKey: ["sales", "invoice", invoiceKey],
    enabled: Boolean(line),
    staleTime: 5 * 60_000,
    queryFn: () => salesApi.listInvoiceLinesDetailed(api, line!, { allBranches: isOwner }),
  });

  const inv = useMemo(() => {
    const rows = linesQ.data?.lines ?? (line ? [line] : []);
    return salesApi.groupInvoices(rows)[0] ?? null;
  }, [linesQ.data, line]);
  // Siblings could not be fetched (network) or the page did not even hold
  // this line (other branch, edited date): totals below are not the invoice's.
  const linesIncomplete = linesQ.isError || linesQ.data?.complete === false;
  const receipt = useMemo(() => (inv ? toReceipt(inv) : null), [inv]);

  const refresh = () => {
    void lineQ.refetch();
    void linesQ.refetch();
  };

  const notFound = lineQ.error instanceof ApiError && lineQ.error.status === 404;
  const returnedAmount = inv ? Math.max(0, inv.total - inv.netTotal) : 0;
  const customerLabel = inv?.customerName?.trim() || inv?.customerPhone || null;

  return (
    <Screen onRefresh={refresh} refreshing={lineQ.isRefetching || linesQ.isRefetching}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("app.common.back")}
        hitSlop={8}
        style={styles.crumb}
        onPress={() => (router.canGoBack() ? router.back() : router.navigate("/sales/history"))}
      >
        <ChevronBack size={16} color={colors.textSecondary} />
        <Text style={styles.crumbText}>{t("mobile.salesHistory.title")}</Text>
      </Pressable>

      {lineQ.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : !inv ? (
        <Card>
          <EmptyState title={notFound ? t("mobile.saleDetail.notFound") : t("app.common.errorRetry")} />
          {!notFound ? <Button label={t("app.common.retry")} variant="outline" onPress={refresh} /> : null}
        </Card>
      ) : (
        <>
          {/* Header */}
          <View style={styles.head} testID="sale-detail-head">
            <Text style={styles.kicker}>{t("mobile.saleDetail.title")}</Text>
            <Text style={styles.invoice} selectable>
              {inv.invoiceId ?? inv.key}
            </Text>
            <Text style={styles.when}>
              {ltr(`${shortDate(inv.saleDate)} · ${timeOf(inv.saleDate)}`)}
            </Text>
            <View style={styles.badges}>
              <Badge label={paymentLabel(inv.paymentMethod)} variant={inv.paymentMethod === "deferred" ? "lowstock" : "accent"} />
              {inv.fullyReturned ? (
                <Badge label={t("app.sales.status.returned")} variant="outofstock" />
              ) : inv.hasReturn ? (
                <Badge label={t("mobile.salesHistory.partialReturn")} variant="lowstock" />
              ) : null}
              {inv.paymentMethod === "deferred" ? (
                inv.outstanding > 0 ? (
                  <Badge label={t("mobile.customers.remaining", { amount: money(inv.outstanding) })} variant="outofstock" />
                ) : (
                  <Badge label={t("mobile.saleDetail.paidInFull")} variant="success" />
                )
              ) : null}
            </View>
          </View>

          {/* Lines */}
          <Card title={t("mobile.saleDetail.items")}>
            {/* Receipt layout: qty × unit price ride under the name so the
                product column keeps the width a phone can spare. */}
            <View style={[styles.lineRow, styles.lineHead]}>
              <View style={styles.colName}>
                <Text style={styles.th}>{t("app.sales.table.col.product")}</Text>
              </View>
              <Text style={[styles.th, styles.colAmt]}>{t("app.sales.table.col.total")}</Text>
            </View>
            {inv.lines.map((l) => (
              <View key={l.id} style={styles.lineRow} testID={`sale-line-${l.id}`}>
                <View style={styles.colName}>
                  <Text style={[styles.lineName, l.isReturned && styles.struck]} numberOfLines={2}>
                    {l.productName}
                  </Text>
                  {l.brand ? <Text style={styles.lineSub}>{l.brand}</Text> : null}
                  <Text style={[styles.lineSub, styles.lineQty]}>
                    {t("mobile.saleDetail.qtyAtPrice", {
                      qty: groupDigits(l.quantitySold),
                      price: money(l.pricePerUnit),
                    })}
                  </Text>
                  {(l.discountAmount ?? 0) > 0 ? (
                    <Text style={styles.lineSub}>
                      {t("app.common.discount")} {negative(l.discountAmount ?? 0)}
                    </Text>
                  ) : null}
                  {l.isReturned || (l.returnedQuantity ?? 0) > 0 ? (
                    <Text style={styles.lineReturned}>
                      {t("mobile.saleDetail.returnedQty", { n: l.returnedQuantity ?? l.quantitySold })}
                    </Text>
                  ) : null}
                </View>
                <Text style={[styles.lineNum, styles.lineTotal, styles.colAmt, l.isReturned && styles.struck]}>
                  {money(l.totalPrice)}
                </Text>
              </View>
            ))}
            {linesIncomplete && inv.invoiceId ? (
              <Text style={styles.warn}>{t("mobile.saleDetail.linesIncomplete")}</Text>
            ) : null}

            <View style={styles.totals}>
              {/* Subtotal only earns a row when a discount separates it from the
                  total — otherwise it duplicates the total and names a discount
                  that does not exist. */}
              {inv.discount > 0 ? (
                <>
                  <TotalRow label={t("mobile.saleDetail.subtotal")} value={money(inv.subtotal)} />
                  <TotalRow label={t("app.common.discount")} value={negative(inv.discount)} />
                </>
              ) : null}
              <TotalRow label={t("app.common.total")} value={money(inv.total)} strong />
              {returnedAmount > 0 ? (
                <TotalRow label={t("app.sales.status.returned")} value={negative(returnedAmount)} danger />
              ) : null}
              {returnedAmount > 0 ? (
                <TotalRow label={t("mobile.saleDetail.net")} value={money(inv.netTotal)} strong />
              ) : null}
            </View>
          </Card>

          {/* Payment */}
          <Card title={t("mobile.saleDetail.payment")}>
            <TotalRow label={t("app.activityLabels.fields.paymentMethod")} value={paymentLabel(inv.paymentMethod)} />
            {inv.paymentMethod === "deferred" ? (
              <>
                <TotalRow label={t("mobile.saleDetail.paid")} value={money(inv.amountPaid)} />
                <TotalRow
                  label={t("mobile.saleDetail.remaining")}
                  value={money(inv.outstanding)}
                  strong
                  danger={inv.outstanding > 0}
                />
              </>
            ) : null}
            {inv.note ? (
              <View style={styles.note}>
                <Text style={styles.noteLabel}>{t("app.common.notes")}</Text>
                <Text style={styles.noteText}>{inv.note}</Text>
              </View>
            ) : null}
          </Card>

          {/* Customer */}
          <Card title={t("mobile.saleDetail.customer")}>
            {inv.customerPhone ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("mobile.saleDetail.openCustomer")}
                style={({ pressed }) => [styles.customerRow, pressed && styles.pressed]}
                onPress={() => router.push(`/customers/${encodeURIComponent(inv.customerPhone!)}`)}
                testID="sale-detail-customer-link"
              >
                <View style={styles.customerIcon}>
                  <User size={20} color={colors.accent} />
                </View>
                <View style={styles.customerText}>
                  <Text style={styles.customerName}>{customerLabel}</Text>
                  {inv.customerName?.trim() ? (
                    <Text style={styles.customerPhone}>{ltr(inv.customerPhone)}</Text>
                  ) : null}
                </View>
                <ChevronForward size={16} color={colors.textSecondary} />
              </Pressable>
            ) : (
              <Text style={styles.walkIn}>{customerLabel ?? t("mobile.saleDetail.walkIn")}</Text>
            )}
          </Card>

          {/* Receipt */}
          {receipt ? (
            <Card title={t("mobile.saleDetail.receipt")}>
              <ReceiptActions sale={receipt} />
            </Card>
          ) : null}

          {/* Return */}
          {canReturn && !inv.fullyReturned ? (
            <Button
              label={t("app.sales.returnModal.title")}
              variant="outline"
              onPress={() =>
                router.push({
                  pathname: "/returns",
                  params: { saleId: inv.lines[0]?.id ?? lineId, invoiceId: inv.invoiceId ?? "" },
                })
              }
            />
          ) : null}
          {inv.fullyReturned ? (
            <View style={styles.returnedNote}>
              <ArrowUUpLeft size={16} color={colors.textSecondary} />
              <Text style={styles.returnedNoteText}>{t("app.sales.status.returned")}</Text>
            </View>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function TotalRow({
  label,
  value,
  strong,
  danger,
}: {
  label: string;
  value: string;
  strong?: boolean;
  danger?: boolean;
}) {
  return (
    <View style={styles.totalRow}>
      <Text style={[styles.totalLabel, strong && styles.totalLabelStrong]}>{label}</Text>
      <Text style={[styles.totalValue, strong && styles.totalValueStrong, danger && styles.totalValueDanger]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  crumb: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: spacing.xs,
    minHeight: MIN_TOUCH,
  },
  crumbText: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  head: { gap: spacing.xs, alignItems: "flex-start" },
  kicker: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  invoice: { fontFamily: fonts.bold, fontSize: 22, color: colors.text, ...RTL_TEXT },
  when: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.xs },
  lineRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  lineHead: { paddingTop: 0 },
  th: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary },
  colName: { flex: 1, gap: 2, alignItems: "flex-start" },
  // End-aligned ("right" = END under the Fabric swap) so the line totals share
  // the TotalRow values' edge below them — one amount column, one edge.
  colAmt: { width: 92, fontVariant: ["tabular-nums"], textAlign: "right" },
  lineName: { fontFamily: fonts.medium, fontSize: 14, color: colors.text, ...RTL_TEXT },
  lineSub: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  lineReturned: { fontFamily: fonts.medium, fontSize: 12, color: colors.danger, ...RTL_TEXT },
  lineQty: { fontVariant: ["tabular-nums"] },
  lineNum: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 14, color: colors.text, paddingTop: 2 },
  lineTotal: { ...RTL_TEXT, fontFamily: fonts.semibold },
  struck: { color: colors.textSecondary, textDecorationLine: "line-through" },
  warn: {
    alignSelf: "flex-start",
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.warningStrong,
    paddingTop: spacing.sm,
    ...RTL_TEXT,
  },
  totals: { paddingTop: spacing.md, gap: spacing.xs },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.md, minHeight: 28 },
  totalLabel: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  totalLabelStrong: { ...RTL_TEXT, fontFamily: fonts.semibold, color: colors.text },
  totalValue: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.text, fontVariant: ["tabular-nums"] },
  totalValueStrong: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 17 },
  totalValueDanger: { color: colors.danger },
  note: { marginTop: spacing.sm, gap: 2, alignItems: "flex-start" },
  noteLabel: { fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  noteText: { fontFamily: fonts.regular, fontSize: 14, color: colors.text, ...RTL_TEXT },
  customerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
  },
  pressed: { backgroundColor: colors.accentLight },
  customerIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  customerText: { flex: 1, gap: 1, alignItems: "flex-start" },
  customerName: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  customerPhone: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  walkIn: { alignSelf: "flex-start", fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  returnedNote: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs },
  returnedNoteText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary },
});
