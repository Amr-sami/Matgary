import { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarBlank,
  CaretRight,
  CheckCircle,
  Phone,
  Receipt,
  ShoppingCart,
  Wallet,
} from "phosphor-react-native";
import { ApiError } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { money, shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Port of app__customer-detail.png (/customers/<urlencoded-phone>).
 *
 * The capture only froze the 404 state — "لا توجد فواتير لهذا العميل في الفرع
 * الحالي." under a cart glyph, with the breadcrumb above it and nothing else.
 * That state is matched exactly. Everything below it is ported from the web
 * page the capture came from (apps/web/app/customers/[phone]/page.tsx), in its
 * order: header card → four stats → invoice ledger with a per-invoice payment
 * timeline.
 *
 * Read-only. The web's write actions (تأكيد دفع الكل, the per-invoice settle
 * modal, the WhatsApp reminders) and the loyalty wallet card are NOT here —
 * see the report. Nothing on this screen mutates.
 */

/** apps/web/lib/repo/customers.ts — LedgerInvoice, serialised. */
interface LedgerLine {
  saleId: string;
  productName: string;
  quantity: number;
  pricePerUnit: number;
  lineTotal: number;
}

interface LedgerInvoice {
  invoiceId: string;
  saleIds: string[];
  date: string;
  total: number;
  /** Migration 0037: cash collected against this invoice, 0 ≤ x ≤ total. */
  amountPaid: number;
  /** total − amountPaid, pre-computed server-side. */
  balance: number;
  isPaid: boolean;
  paidAt: string | null;
  paymentMethod: string | null;
  lines: LedgerLine[];
}

interface LedgerData {
  customerName: string | null;
  customerPhone: string;
  invoiceCount: number;
  lifetimeValue: number;
  outstandingBalance: number;
  paidBalance: number;
  firstVisit: string | null;
  lastVisit: string | null;
  invoices: LedgerInvoice[];
}

interface LedgerResponse {
  data: LedgerData;
  branchId: string;
  branchName: string;
}

/** Migration 0038 — one row per settle action. */
interface PaymentEvent {
  id: string;
  saleId: string;
  invoiceId: string | null;
  amount: number;
  method: string;
  recordedAt: string;
  note: string | null;
  recordedByName: string | null;
}

const METHOD_LABELS: Record<string, string> = {
  cash: "كاش",
  instapay: "إنستا باي",
  card: "كارت",
};

/**
 * expo-router hands params already decoded, but a phone arrives as
 * `%2B201…` from `encodeURIComponent`, and double-decoding a value with no
 * percent escapes is a no-op — so this is safe either way. A malformed escape
 * throws URIError rather than returning the input, hence the catch.
 */
function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default function CustomerDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ phone: string | string[] }>();
  const raw = Array.isArray(params.phone) ? params.phone[0] : params.phone;
  const phone = decodeParam(raw ?? "");
  const encoded = encodeURIComponent(phone);

  const ledgerQ = useQuery({
    queryKey: ["customer-ledger", phone],
    enabled: phone.length > 0,
    queryFn: async () => {
      try {
        return await api.request<LedgerResponse>(
          `/api/customers/by-phone/${encoded}`,
        );
      } catch (error) {
        // 404 is not a failure here: it is "this customer has no invoices in
        // the active branch", which is its own designed state.
        if (error instanceof ApiError && error.kind === "notFound") return null;
        throw error;
      }
    },
  });

  const paymentsQ = useQuery({
    queryKey: ["customer-payments", phone],
    enabled: phone.length > 0 && Boolean(ledgerQ.data),
    queryFn: () =>
      api.request<{ data: PaymentEvent[] }>(
        `/api/customers/by-phone/${encoded}/payments`,
      ),
  });

  /**
   * Bucket the flat payment list by invoice so each invoice card renders its
   * own timeline without filtering the whole array on every row.
   */
  const paymentsByInvoice = useMemo(() => {
    const map = new Map<string, PaymentEvent[]>();
    for (const p of paymentsQ.data?.data ?? []) {
      const key = p.invoiceId ?? p.saleId;
      const bucket = map.get(key);
      if (bucket) bucket.push(p);
      else map.set(key, [p]);
    }
    return map;
  }, [paymentsQ.data]);

  const refresh = () => {
    void ledgerQ.refetch();
    void paymentsQ.refetch();
  };

  const ledger = ledgerQ.data?.data ?? null;
  const branchName = ledgerQ.data?.branchName ?? "";
  const hasDebt = (ledger?.outstandingBalance ?? 0) > 0;

  return (
    <Screen onRefresh={refresh} refreshing={ledgerQ.isRefetching}>
      {/* The web's BackLink: a right-pointing caret then the list's name. Under
          RTL the caret lands on the right edge, exactly as the capture shows. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="العودة لقائمة العملاء"
        hitSlop={8}
        style={styles.crumb}
        onPress={() => router.navigate("/customers")}
      >
        <CaretRight size={16} color={colors.textSecondary} />
        <Text style={styles.crumbText}>العملاء</Text>
      </Pressable>

      {ledgerQ.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : !ledger ? (
        <View style={styles.emptyWrap}>
          <ShoppingCart size={44} color={colors.textSecondary} />
          <EmptyState
            title={
              ledgerQ.error
                ? "تعذّر تحميل بيانات العميل."
                : "لا توجد فواتير لهذا العميل في الفرع الحالي."
            }
          />
        </View>
      ) : (
        <>
          <Card>
            <View style={styles.headRow}>
              <View style={styles.headMain}>
                <Text numberOfLines={1} style={styles.name}>
                  {ledger.customerName?.trim() || ledger.customerPhone || phone}
                </Text>
                {ledger.customerPhone ? (
                  <View style={styles.phoneRow}>
                    <Phone size={14} color={colors.textSecondary} />
                    <Text numberOfLines={1} style={styles.meta}>
                      {ledger.customerPhone}
                    </Text>
                  </View>
                ) : null}
                {branchName ? (
                  <Text numberOfLines={1} style={styles.branch}>
                    بيانات الفرع: {branchName}
                  </Text>
                ) : null}
              </View>

              {hasDebt ? (
                <View style={styles.debtBlock}>
                  <Text numberOfLines={1} style={styles.debtLabel}>
                    متبقي من العميل
                  </Text>
                  <Text numberOfLines={1} style={styles.debtValue}>
                    {money(ledger.outstandingBalance)}
                  </Text>
                </View>
              ) : null}
            </View>

            <View style={styles.statGrid}>
              <Stat
                icon={<Wallet size={14} color={colors.textSecondary} />}
                label="إجمالي الإنفاق"
                value={money(ledger.lifetimeValue)}
              />
              <Stat
                icon={<CheckCircle size={14} color={colors.success} />}
                label="مدفوع"
                value={money(ledger.paidBalance)}
              />
              <Stat
                icon={<Receipt size={14} color={colors.textSecondary} />}
                label="عدد الفواتير"
                value={String(ledger.invoiceCount)}
              />
              <Stat
                icon={<CalendarBlank size={14} color={colors.textSecondary} />}
                label="آخر زيارة"
                value={ledger.lastVisit ? shortDate(ledger.lastVisit) : "—"}
              />
            </View>
          </Card>

          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Receipt size={18} color={colors.textSecondary} />
              <Text style={styles.sectionTitle}>سجل الفواتير</Text>
            </View>

            <View style={styles.ledger}>
              {ledger.invoices.map((inv, index) => {
                const events = paymentsByInvoice.get(inv.invoiceId) ?? [];
                const partial = !inv.isPaid && inv.amountPaid > 0;
                return (
                  <View
                    key={inv.invoiceId}
                    style={[
                      styles.invoice,
                      index > 0 && styles.invoiceDivided,
                      !inv.isPaid && styles.invoiceUnpaid,
                    ]}
                  >
                    <View style={styles.invoiceHead}>
                      <View style={styles.invoiceMain}>
                        <View style={styles.invoiceIdRow}>
                          <Text numberOfLines={1} style={styles.invoiceId}>
                            {inv.invoiceId}
                          </Text>
                          {inv.isPaid ? (
                            <Badge label="مدفوع" variant="success" />
                          ) : partial ? (
                            <Badge label="جزئي" variant="lowstock" />
                          ) : (
                            <Badge label="آجل" variant="outofstock" />
                          )}
                        </View>
                        <Text style={styles.invoiceMeta}>
                          {shortDate(inv.date)} · {inv.lines.length} قطعة
                          {inv.paidAt ? ` · دُفع ${shortDate(inv.paidAt)}` : ""}
                        </Text>
                      </View>

                      <View style={styles.invoiceTotals}>
                        <Text numberOfLines={1} style={styles.invoiceTotal}>
                          {money(inv.total)}
                        </Text>
                        {partial ? (
                          <>
                            <Text numberOfLines={1} style={styles.paidLine}>
                              مدفوع: {money(inv.amountPaid)}
                            </Text>
                            <Text numberOfLines={1} style={styles.dueLine}>
                              متبقي: {money(inv.balance)}
                            </Text>
                          </>
                        ) : null}
                      </View>
                    </View>

                    <View style={styles.lines}>
                      {inv.lines.map((l) => (
                        <View key={l.saleId} style={styles.lineRow}>
                          <Text numberOfLines={1} style={styles.lineName}>
                            {l.productName} ×{l.quantity}
                          </Text>
                          <Text numberOfLines={1} style={styles.lineTotal}>
                            {money(l.lineTotal)}
                          </Text>
                        </View>
                      ))}
                    </View>

                    {events.length > 0 ? (
                      <View style={styles.timeline}>
                        <Text style={styles.timelineTitle}>سجل الدفعات</Text>
                        {events.map((p) => (
                          <View key={p.id} style={styles.eventRow}>
                            <View style={styles.eventMain}>
                              <Text style={styles.eventDate}>
                                {shortDate(p.recordedAt)}
                              </Text>
                              <Badge
                                label={METHOD_LABELS[p.method] ?? "دفعة سابقة"}
                                variant={
                                  p.method === "cash"
                                    ? "success"
                                    : p.method === "initial"
                                      ? "neutral"
                                      : "accent"
                                }
                              />
                              {p.recordedByName ? (
                                <Text numberOfLines={1} style={styles.eventBy}>
                                  {p.recordedByName}
                                </Text>
                              ) : null}
                            </View>
                            <Text numberOfLines={1} style={styles.eventAmount}>
                              {money(p.amount)}
                            </Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          </View>
        </>
      )}
    </Screen>
  );
}

/** The web's four-up Stat: a small icon + label line, value underneath. */
function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.stat}>
      <View style={styles.statLabelRow}>
        {icon}
        <Text numberOfLines={1} style={styles.statLabel}>
          {label}
        </Text>
      </View>
      <Text numberOfLines={1} style={styles.statValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  crumb: { flexDirection: "row", alignItems: "center", gap: spacing.xs, minHeight: 44 },
  crumbText: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },

  emptyWrap: { alignItems: "center", paddingTop: spacing.xxl * 2, gap: spacing.md },

  headRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  headMain: { flex: 1, minWidth: 0, gap: 4 },
  name: { fontFamily: fonts.bold, fontSize: 20, color: colors.text, ...RTL_TEXT },
  phoneRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  meta: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
  branch: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },

  debtBlock: { alignItems: "flex-start", flexShrink: 0, gap: 2 },
  debtLabel: { fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary },
  debtValue: {
    fontFamily: fonts.bold,
    fontSize: 22,
    color: colors.warningStrong,
    fontVariant: ["tabular-nums"],
  },

  statGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    rowGap: spacing.md,
  },
  // 50% columns with an end-side gutter so the left column's value never
  // butts up against the right column's label. Web uses `gap-3`.
  stat: { width: "50%", paddingEnd: spacing.md, gap: 2 },
  statLabelRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  statLabel: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary, ...RTL_TEXT },
  statValue: {
    fontFamily: fonts.bold,
    fontSize: 14,
    color: colors.text,
    fontVariant: ["tabular-nums"],
    ...RTL_TEXT,
  },

  section: { gap: spacing.md },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  sectionTitle: { fontFamily: fonts.bold, fontSize: 16, color: colors.text, ...RTL_TEXT },

  ledger: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    ...elevation.card,
  },
  invoice: { padding: spacing.lg, gap: spacing.sm },
  invoiceDivided: { borderTopWidth: 1, borderTopColor: colors.border },
  invoiceUnpaid: { backgroundColor: colors.warningLight },
  invoiceHead: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  invoiceMain: { flex: 1, minWidth: 0, gap: 4 },
  invoiceIdRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  invoiceId: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 14, color: colors.text },
  invoiceMeta: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  invoiceTotals: { alignItems: "flex-start", flexShrink: 0, gap: 2 },
  invoiceTotal: {
    fontFamily: fonts.bold,
    fontSize: 17,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  paidLine: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.successStrong,
    fontVariant: ["tabular-nums"],
  },
  dueLine: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    color: colors.warningStrong,
    fontVariant: ["tabular-nums"],
  },

  lines: { gap: 2 },
  lineRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  lineName: { flex: 1, minWidth: 0, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  lineTotal: {
    flexShrink: 0,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },

  timeline: {
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.xs,
  },
  timelineTitle: { fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary, ...RTL_TEXT },
  eventRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  eventMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  eventDate: { flexShrink: 0, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  eventBy: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary, ...RTL_TEXT },
  eventAmount: {
    flexShrink: 0,
    fontFamily: fonts.bold,
    fontSize: 13,
    color: colors.successStrong,
    fontVariant: ["tabular-nums"],
  },
});
