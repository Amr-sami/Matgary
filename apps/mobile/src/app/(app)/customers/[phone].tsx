import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarBlankIcon as CalendarBlank } from "phosphor-react-native/src/icons/CalendarBlank";
import { CheckCircleIcon as CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { CoinsIcon as Coins } from "phosphor-react-native/src/icons/Coins";
import { PhoneIcon as Phone } from "phosphor-react-native/src/icons/Phone";
import { ReceiptIcon as Receipt } from "phosphor-react-native/src/icons/Receipt";
import { ShoppingCartIcon as ShoppingCart } from "phosphor-react-native/src/icons/ShoppingCart";
import { StarIcon as Star } from "phosphor-react-native/src/icons/Star";
import { WalletIcon as Wallet } from "phosphor-react-native/src/icons/Wallet";
import { ApiError, catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { ChevronBack } from "@/components/ui/Chevron";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { Sheet } from "@/components/ui/Sheet";
import { money, shortDate } from "@/lib/format";
import { customerPhoneParam } from "@/lib/customer-phone";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Doc 02 §1.1 row 6 — RECOMPOSE: ledger + wallet + tap-to-settle per invoice
 * + mark-all-paid. The three parallel fetches (ledger, wallet, payments) stay
 * as-is, each its own query so a wallet hiccup never blanks the ledger.
 *
 * Writes go through the web's own handlers — `POST /api/sales/settle` with
 * one `invoiceIds` entry (the InvoiceSettleModal contract) and
 * `POST …/mark-all-paid` (modify_sales). Both invalidate the ledger, the
 * payment log, the wallet and the customers list, so the receivables ranking
 * on the previous screen is right the moment the user goes back.
 */

type LedgerInvoice = catalog.CustomerLedgerInvoice;
type PaymentEvent = catalog.CustomerPaymentEvent;
type Method = catalog.SettlementMethod;

// One namespace for payment names across POS, dashboard, history and detail.
const METHOD_LABELS = (): Record<string, string> => ({
  cash: t("app.activityLabels.paymentMethods.cash"),
  instapay: t("app.activityLabels.paymentMethods.instapay"),
  card: t("app.activityLabels.paymentMethods.card"),
});

const METHODS = (): { key: Method; label: string }[] =>
  (["cash", "instapay", "card"] as const).map((key) => ({ key, label: METHOD_LABELS()[key] ?? key }));

/** Arabic counts 1 / 2 / 3–10 / 11+ differently; the dictionary carries One/Two/Few beside the default. */
function countForm(n: number): string {
  return n === 1 ? "One" : n === 2 ? "Two" : n >= 3 && n <= 10 ? "Few" : "";
}

/** app.customers.settle.errors.* — the server's error codes, or GENERIC. */
function settleErrorMessage(error: unknown): string {
  // http.ts lifts the server's `{ error }` string into ApiError.code.
  const code = error instanceof ApiError ? (error.code ?? "") : "";
  const known = ["INVALID_PHONE", "INVALID_AMOUNT", "INVALID_METHOD", "NOTHING_TO_SETTLE"];
  return t(`app.customers.settle.errors.${known.includes(code) ? code : "GENERIC"}`);
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

export default function CustomerDetailScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ phone: string | string[] }>();
  // Decoded to a stable value, then E.164 — the in-app push, a custom-scheme
  // deep link (`%2B…`, or double-encoded) and a "+" mangled into a space all
  // resolve to the same key. See lib/customer-phone.ts.
  const phone = customerPhoneParam(params.phone);

  const isOwner = useSession((s) => s.me?.isOwner ?? false);
  const permissions = useSession((s) => s.me?.permissions);
  const canModifySales = isOwner || Boolean(permissions?.includes("modify_sales"));

  const ledgerQ = useQuery({
    queryKey: ["customer-ledger", phone],
    enabled: phone.length > 0,
    queryFn: async () => {
      try {
        return await catalog.getCustomerLedger(api, phone);
      } catch (error) {
        // 404 is not a failure here: it is "this customer has no invoices in
        // the active branch", which is its own designed state.
        if (error instanceof ApiError && error.kind === "notFound") return null;
        throw error;
      }
    },
  });

  const walletQ = useQuery({
    queryKey: ["customer-wallet", phone],
    enabled: phone.length > 0 && Boolean(ledgerQ.data),
    queryFn: () => catalog.getCustomerWallet(api, phone),
  });

  const paymentsQ = useQuery({
    queryKey: ["customer-payments", phone],
    enabled: phone.length > 0 && Boolean(ledgerQ.data),
    queryFn: () => catalog.listCustomerPayments(api, phone),
  });

  /**
   * Bucket the flat payment list by invoice so each invoice card renders its
   * own timeline without filtering the whole array on every row.
   */
  const paymentsByInvoice = useMemo(() => {
    const map = new Map<string, PaymentEvent[]>();
    for (const p of paymentsQ.data ?? []) {
      const key = p.invoiceId ?? p.saleId;
      const bucket = map.get(key);
      if (bucket) bucket.push(p);
      else map.set(key, [p]);
    }
    return map;
  }, [paymentsQ.data]);

  /** Everything a settlement changes — including the list's ranking. */
  const invalidateAll = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["customer-ledger", phone] }),
      qc.invalidateQueries({ queryKey: ["customer-payments", phone] }),
      qc.invalidateQueries({ queryKey: ["customer-wallet", phone] }),
      qc.invalidateQueries({ queryKey: ["customers"] }),
    ]);

  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  const [settleTarget, setSettleTarget] = useState<LedgerInvoice | null>(null);

  const settle = useMutation({
    mutationFn: (input: { invoice: LedgerInvoice; amount: number; method: Method }) =>
      catalog.settleCustomer(api, {
        customerPhone: phone,
        amount: input.amount,
        method: input.method,
        invoiceIds: [input.invoice.invoiceId],
      }),
    onSuccess: async (result) => {
      setSettleTarget(null);
      setNotice({ kind: "success", text: t("mobile.customers.settleDone", { amount: money(result.appliedAmount) }) });
      await invalidateAll();
    },
  });

  const markAll = useMutation({
    mutationFn: () => catalog.markCustomerAllPaid(api, phone),
    onSuccess: async (result) => {
      setNotice({
        kind: "success",
        text: t("mobile.customers.markAllDone", { n: result.markedCount, amount: money(result.markedTotal) }),
      });
      await invalidateAll();
    },
    onError: () => setNotice({ kind: "error", text: t("mobile.customers.updateFailed") }),
  });

  const refresh = () => {
    void ledgerQ.refetch();
    void walletQ.refetch();
    void paymentsQ.refetch();
  };

  const ledger = ledgerQ.data?.data ?? null;
  const branchName = ledgerQ.data?.branchName ?? "";
  const hasDebt = (ledger?.outstandingBalance ?? 0) > 0;
  const unpaid = useMemo(() => ledger?.invoices.filter((i) => !i.isPaid) ?? [], [ledger]);
  const oldestUnpaid = useMemo(() => {
    let oldest: number | null = null;
    for (const inv of unpaid) {
      const d = daysSince(inv.date);
      if (d !== null && (oldest === null || d > oldest)) oldest = d;
    }
    return oldest;
  }, [unpaid]);

  const confirmMarkAll = () => {
    if (!ledger || !hasDebt || markAll.isPending) return;
    Alert.alert(
      t("mobile.customers.markAllPaid"),
      t("mobile.customers.markAllConfirm", { amount: money(ledger.outstandingBalance) }),
      [
        { text: t("app.common.cancel"), style: "cancel" },
        { text: t("app.common.confirm"), style: "destructive", onPress: () => markAll.mutate() },
      ],
    );
  };

  return (
    <Screen onRefresh={refresh} refreshing={ledgerQ.isRefetching}>
      {/* The web's BackLink: a right-pointing caret then the list's name. Under
          RTL the caret lands on the right edge, exactly as the capture shows. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("mobile.customers.backToList")}
        hitSlop={8}
        style={styles.crumb}
        onPress={() => router.navigate("/customers")}
      >
        <ChevronBack size={16} color={colors.textSecondary} />
        <Text style={styles.crumbText}>{t("app.customers.title")}</Text>
      </Pressable>

      {notice ? (
        <View style={[styles.notice, notice.kind === "error" ? styles.noticeError : styles.noticeSuccess]}>
          <Text
            style={[styles.noticeText, notice.kind === "error" ? styles.noticeTextError : styles.noticeTextSuccess]}
            testID="customer-notice"
          >
            {notice.text}
          </Text>
        </View>
      ) : null}

      {ledgerQ.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : !ledger ? (
        <View style={styles.emptyWrap}>
          <ShoppingCart size={44} color={colors.textSecondary} />
          <EmptyState
            title={
              ledgerQ.error
                ? t("mobile.customers.loadFailed")
                : t("mobile.customers.noInvoicesBranch")
            }
          />
          {/* Pull-to-refresh is the only other way back from a failed load,
              and nothing on a near-empty screen suggests it exists. */}
          {ledgerQ.error ? (
            <Button variant="outline" label={t("app.common.retry")} onPress={refresh} />
          ) : null}
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
                    {/* LRI…PDI: writingDirection is iOS-only; Android would trail the plus. */}
                    <Text numberOfLines={1} style={[styles.meta, styles.ltr]}>
                      {`\u2066${ledger.customerPhone}\u2069`}
                    </Text>
                  </View>
                ) : null}
                {branchName ? (
                  <Text numberOfLines={1} style={styles.branch}>
                    {t("mobile.customers.branchData", { branch: branchName })}
                  </Text>
                ) : null}
              </View>

              {hasDebt ? (
                <View style={styles.debtBlock}>
                  <Text numberOfLines={1} style={styles.debtLabel}>
                    {t("mobile.customers.outstandingFromCustomer")}
                  </Text>
                  <Text numberOfLines={1} style={styles.debtValue} testID="customer-outstanding">
                    {money(ledger.outstandingBalance)}
                  </Text>
                </View>
              ) : null}
            </View>

            {hasDebt ? (
              <View style={styles.debtMeta}>
                <Badge label={t(`mobile.customers.unpaidCount${countForm(unpaid.length)}`, { n: unpaid.length })} variant="outofstock" />
                {oldestUnpaid !== null ? (
                  <Badge
                    label={t("mobile.customers.oldestUnpaidDays", { n: oldestUnpaid })}
                    variant={oldestUnpaid >= 30 ? "outofstock" : "lowstock"}
                  />
                ) : null}
              </View>
            ) : null}

            <View style={styles.statGrid}>
              <Stat
                icon={<Wallet size={14} color={colors.textSecondary} />}
                label={t("app.customers.row.lifetime")}
                value={money(ledger.lifetimeValue)}
              />
              <Stat
                icon={<CheckCircle size={14} color={colors.success} />}
                label={t("app.sales.deferred.markPaid")}
                value={money(ledger.paidBalance)}
              />
              <Stat
                icon={<Receipt size={14} color={colors.textSecondary} />}
                label={t("mobile.customers.invoiceCount")}
                value={String(ledger.invoiceCount)}
              />
              <Stat
                icon={<CalendarBlank size={14} color={colors.textSecondary} />}
                label={t("mobile.customers.lastVisit")}
                value={ledger.lastVisit ? shortDate(ledger.lastVisit) : "—"}
              />
            </View>

            {hasDebt && canModifySales ? (
              <View style={styles.actions}>
                <Button
                  label={t("mobile.customers.markAllPaid")}
                  onPress={confirmMarkAll}
                  loading={markAll.isPending}
                />
              </View>
            ) : null}
          </Card>

          {/* Loyalty wallet — points + store credit for this branch. Zero
              balances are still shown: "0 points" tells the cashier the
              programme is on but the customer has not earned yet. */}
          <Card>
            <View style={styles.sectionHead}>
              <Coins size={18} color={colors.textSecondary} />
              <Text style={styles.sectionTitle}>{t("mobile.customers.walletTitle")}</Text>
            </View>
            {walletQ.isLoading ? (
              <ActivityIndicator color={colors.accent} />
            ) : walletQ.isError ? (
              <Text style={styles.meta}>{t("app.common.error")}</Text>
            ) : (
              <View style={styles.walletRow}>
                <View style={styles.walletCell}>
                  <View style={styles.statLabelRow}>
                    <Star size={14} color={colors.accent} />
                    <Text numberOfLines={1} style={styles.statLabel}>
                      {t("mobile.customers.walletPoints")}
                    </Text>
                  </View>
                  <Text numberOfLines={1} style={styles.walletValue}>
                    {String(walletQ.data?.wallet.points ?? 0)}
                  </Text>
                </View>
                <View style={styles.walletCell}>
                  <View style={styles.statLabelRow}>
                    <Wallet size={14} color={colors.successStrong} />
                    <Text numberOfLines={1} style={styles.statLabel}>
                      {t("mobile.customers.walletCredit")}
                    </Text>
                  </View>
                  <Text numberOfLines={1} style={styles.walletValue}>
                    {money(walletQ.data?.wallet.credit ?? 0)}
                  </Text>
                </View>
              </View>
            )}
          </Card>

          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Receipt size={18} color={colors.textSecondary} />
              <Text style={styles.sectionTitle}>{t("mobile.customers.invoiceHistory")}</Text>
            </View>

            <View style={styles.ledger}>
              {ledger.invoices.map((inv, index) => {
                const events = paymentsByInvoice.get(inv.invoiceId) ?? [];
                const partial = !inv.isPaid && inv.amountPaid > 0;
                // A sale recorded before invoices existed has no INV- id; the
                // ledger falls back to the sale id (repo/customers.ts
                // `r.invoiceId ?? r.id`), but /api/sales/settle filters on
                // invoice_id only, so settling it one-by-one always answers
                // NOTHING_TO_SETTLE. Say so instead of offering a dead tap.
                const legacy = inv.saleIds.includes(inv.invoiceId);
                // Gated like "Mark all paid" above: /settle is due to require
                // modify_sales (doc 02), and a sheet that can only fail is
                // worse than no sheet.
                const settleable = canModifySales && !legacy && !inv.isPaid && inv.balance > 0;
                return (
                  <Pressable
                    key={inv.invoiceId}
                    disabled={!settleable}
                    accessibilityRole={settleable ? "button" : undefined}
                    accessibilityLabel={
                      settleable ? t("mobile.customers.settleFor", { id: inv.invoiceId }) : undefined
                    }
                    onPress={() => setSettleTarget(inv)}
                    // e2e: a flow taps the first settleable card by id.
                    testID={settleable ? "customer-invoice-settleable" : "customer-invoice"}
                    style={({ pressed }) => [
                      styles.invoice,
                      index > 0 && styles.invoiceDivided,
                      !inv.isPaid && styles.invoiceUnpaid,
                      pressed && settleable && styles.invoicePressed,
                    ]}
                  >
                    <View style={styles.invoiceHead}>
                      <View style={styles.invoiceMain}>
                        <View style={styles.invoiceIdRow}>
                          <Text numberOfLines={1} style={styles.invoiceId}>
                            {inv.invoiceId}
                          </Text>
                          {inv.isPaid ? (
                            <Badge label={t("app.sales.deferred.markPaid")} variant="success" />
                          ) : partial ? (
                            <Badge label={t("app.purchases.paymentBadge.partial")} variant="lowstock" />
                          ) : (
                            <Badge label={t("app.activityLabels.paymentMethods.deferred")} variant="outofstock" />
                          )}
                        </View>
                        <Text style={styles.invoiceMeta}>
                          {t(`mobile.customers.invoiceMeta${countForm(inv.lines.length)}`, { date: shortDate(inv.date), n: inv.lines.length })}
                          {inv.paidAt ? ` ${t("mobile.customers.paidOn", { date: shortDate(inv.paidAt) })}` : ""}
                        </Text>
                      </View>

                      <View style={styles.invoiceTotals}>
                        <Text numberOfLines={1} style={styles.invoiceTotal}>
                          {money(inv.total)}
                        </Text>
                        {partial ? (
                          <>
                            <Text numberOfLines={1} style={styles.paidLine}>
                              {t("mobile.customers.paid", { amount: money(inv.amountPaid) })}
                            </Text>
                            <Text numberOfLines={1} style={styles.dueLine}>
                              {t("mobile.customers.remaining", { amount: money(inv.balance) })}
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
                        <Text style={styles.timelineTitle}>{t("mobile.customers.paymentLog")}</Text>
                        {events.map((p) => (
                          <View key={p.id} style={styles.eventRow}>
                            <View style={styles.eventMain}>
                              <Text style={styles.eventDate}>
                                {shortDate(p.recordedAt)}
                              </Text>
                              <Badge
                                label={METHOD_LABELS()[p.method] ?? t("mobile.customers.previousPayment")}
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

                    {settleable ? (
                      <Text style={styles.tapHint}>{t("mobile.customers.tapToSettle")}</Text>
                    ) : legacy && !inv.isPaid && inv.balance > 0 ? (
                      <Text style={styles.legacyHint}>{t("mobile.customers.legacyNoSettle")}</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </View>
        </>
      )}

      <SettleSheet
        invoice={settleTarget}
        busy={settle.isPending}
        error={settle.isError ? settleErrorMessage(settle.error) : null}
        onClose={() => {
          if (settle.isPending) return;
          settle.reset();
          setSettleTarget(null);
        }}
        onSubmit={(amount, method) => {
          if (!settleTarget) return;
          settle.mutate({ invoice: settleTarget, amount, method });
        }}
      />
    </Screen>
  );
}

/**
 * Port of apps/web/components/customers/InvoiceSettleModal.tsx as a bottom
 * sheet: amount defaults to the remaining balance and is capped at it, method
 * is a 3-way segment. The invoice's own payment log is already on the card
 * behind the sheet, so it is not repeated here.
 */
function SettleSheet({
  invoice,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  invoice: LedgerInvoice | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (amount: number, method: Method) => void;
}) {
  const [amountInput, setAmountInput] = useState("");
  const [method, setMethod] = useState<Method>("cash");

  // Reset per invoice, not per render: reopening for a different invoice must
  // not carry the previous amount over.
  useEffect(() => {
    if (invoice) {
      setAmountInput(String(invoice.balance));
      setMethod("cash");
    }
  }, [invoice]);

  const balance = invoice?.balance ?? 0;
  const typed = Number(amountInput.replace(/[^\d.]/g, "")) || 0;
  const amount = Math.max(0, Math.min(typed, balance));
  const wouldOverpay = typed > balance;

  return (
    <Sheet
      visible={Boolean(invoice)}
      onClose={onClose}
      title={t("app.customers.settle.title")}
      testID="settle"
      bodyStyle={styles.sheetBody}
      primaryAction={{
        label: `${t("app.customers.settle.submit")} · ${money(amount)}`,
        onPress: () => onSubmit(amount, method),
        loading: busy,
        disabled: amount <= 0,
        testID: "settle-submit",
      }}
      secondaryAction={{ label: t("app.common.cancel"), onPress: onClose, disabled: busy }}
    >
      {invoice ? (
        <Text style={styles.sheetSub}>
          {/* LRI…PDI: the Latin id must not be the paragraph's first strong
              character, or TextKit lays the whole Arabic line out LTR. */}
          {`\u2066${invoice.invoiceId}\u2069`} · {t("mobile.customers.remaining", { amount: money(invoice.balance) })}
        </Text>
      ) : null}
      {invoice && invoice.amountPaid > 0 ? (
        <Text style={styles.sheetSub}>
          {t("mobile.customers.paid", { amount: money(invoice.amountPaid) })}
        </Text>
      ) : null}

      <Field
        label={t("app.customers.settle.amountLabel")}
        value={amountInput}
        onChangeText={setAmountInput}
        keyboardType="decimal-pad"
        editable={!busy}
        testID="settle-amount"
      />
      {wouldOverpay ? (
        <Text style={styles.hint}>{t("app.customers.settle.overpayHint")}</Text>
      ) : null}

      <Text style={styles.fieldLabel}>{t("app.customers.settle.methodLabel")}</Text>
      <Segmented items={METHODS()} value={method} onChange={setMethod} />

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </Sheet>
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

  notice: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md },
  noticeSuccess: { backgroundColor: colors.successLight, borderColor: colors.successStrong },
  noticeError: { backgroundColor: colors.dangerLight, borderColor: colors.danger },
  noticeText: { fontFamily: fonts.medium, fontSize: 13, ...RTL_TEXT },
  noticeTextSuccess: { color: colors.successStrong },
  noticeTextError: { color: colors.danger },

  emptyWrap: { alignItems: "center", paddingTop: spacing.xxl * 2, gap: spacing.md },

  headRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  headMain: { flex: 1, minWidth: 0, gap: 4 },
  name: { fontFamily: fonts.bold, fontSize: 20, color: colors.text, ...RTL_TEXT },
  phoneRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  meta: { ...RTL_TEXT, flexShrink: 1, fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
  // A phone starts with "+", which an RTL paragraph pushes to the end
  // ("201…+"). Pin the paragraph direction; the row still flows RTL.
  ltr: { writingDirection: "ltr" },
  branch: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },

  // The trailing block is end-aligned as a unit ("right" = END under the
  // Fabric swap) so label and amount share the card's far edge.
  debtBlock: { alignItems: "flex-end", flexShrink: 0, gap: 2 },
  debtLabel: { textAlign: "right", fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary },
  debtValue: {
    textAlign: "right",
    fontFamily: fonts.bold,
    fontSize: 22,
    color: colors.warningStrong,
    fontVariant: ["tabular-nums"],
  },
  debtMeta: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.md },

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
  // flex-start so label row and value both hug the start edge — a stretched
  // value Text falls back to its own first-strong character and drifts left.
  stat: { width: "50%", paddingEnd: spacing.md, gap: 2, alignItems: "flex-start" },
  statLabelRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  statLabel: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary, ...RTL_TEXT },
  statValue: {
    fontFamily: fonts.bold,
    fontSize: 14,
    color: colors.text,
    fontVariant: ["tabular-nums"],
    ...RTL_TEXT,
  },
  actions: { marginTop: spacing.lg },

  // Same 50% + end-gutter columns as `stat`, so the wallet's second column
  // starts on the stats grid's second column (a row gap + flex:1 put it ~6pt off).
  walletRow: { flexDirection: "row", marginTop: spacing.md },
  walletCell: { width: "50%", paddingEnd: spacing.md, gap: 2, alignItems: "flex-start" },
  walletValue: {
    fontFamily: fonts.bold,
    fontSize: 18,
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
  invoicePressed: { backgroundColor: colors.warningTint },
  invoiceHead: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  invoiceMain: { flex: 1, minWidth: 0, gap: 4 },
  invoiceIdRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  invoiceId: { ...RTL_TEXT, flexShrink: 1, fontFamily: fonts.medium, fontSize: 14, color: colors.text },
  invoiceMeta: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  invoiceTotals: { alignItems: "flex-start", flexShrink: 0, gap: 2 },
  invoiceTotal: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 17,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  paidLine: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.successStrong,
    fontVariant: ["tabular-nums"],
  },
  dueLine: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 11,
    color: colors.warningStrong,
    fontVariant: ["tabular-nums"],
  },
  tapHint: { fontFamily: fonts.medium, fontSize: 12, color: colors.accent, ...RTL_TEXT },
  // Muted on purpose: it explains why there is nothing to tap.
  legacyHint: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },

  lines: { gap: 2 },
  lineRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  lineName: { flex: 1, minWidth: 0, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  lineTotal: {
    ...RTL_TEXT,
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
  eventDate: { ...RTL_TEXT, flexShrink: 0, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  eventBy: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary, ...RTL_TEXT },
  eventAmount: {
    ...RTL_TEXT,
    flexShrink: 0,
    fontFamily: fonts.bold,
    fontSize: 13,
    color: colors.successStrong,
    fontVariant: ["tabular-nums"],
  },

  // Settle sheet
  sheetBody: { gap: spacing.md },
  sheetSub: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  fieldLabel: { fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  hint: { fontFamily: fonts.regular, fontSize: 12, color: colors.warningStrong, ...RTL_TEXT },
  errorText: { fontFamily: fonts.medium, fontSize: 13, color: colors.danger, ...RTL_TEXT },
});
