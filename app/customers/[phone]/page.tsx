"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  ChevronRight,
  Phone,
  Wallet,
  CheckCircle,
  MessageCircle,
  Bell,
  Calendar,
  Receipt,
  Star,
  Plus,
  Minus,
} from "@/lib/icons";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useShopSettings } from "@/hooks/useShopSettings";
import { formatPrice, formatDate } from "@/lib/utils";
import { InvoiceSettleModal } from "@/components/customers/InvoiceSettleModal";

// Customer ledger detail. Lives at /customers/<urlencoded-phone>. Shows:
//   - header: name, phone, outstanding (red if > 0), lifetime, last visit
//   - per-invoice rows with mark-paid + WhatsApp reminder per invoice
//   - bulk "mark all paid" + "send a reminder" actions in the toolbar
//
// Multi-store: scoped to the active branch (server enforces). Owner sees
// the same customer's separate debt at each branch by switching via the
// topbar picker.

interface LedgerInvoice {
  invoiceId: string;
  saleIds: string[];
  date: string;
  total: number;
  /** Migration 0037: cash collected against this invoice (may be 0 ≤ x ≤ total). */
  amountPaid: number;
  /** total − amountPaid. Server pre-computes so the UI doesn't subtract. */
  balance: number;
  isPaid: boolean;
  paidAt: string | null;
  paymentMethod: string | null;
  lines: Array<{
    saleId: string;
    productName: string;
    quantity: number;
    pricePerUnit: number;
    lineTotal: number;
  }>;
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

interface ApiResponse {
  data: LedgerData;
  branchId: string;
  branchName: string;
}

const WALLET_EVENT_LABELS: Record<string, string> = {
  points_earn: "نقاط مكتسبة من فاتورة",
  points_redeem: "نقاط مستخدمة في فاتورة",
  points_expire: "نقاط منتهية",
  credit_grant: "إضافة رصيد",
  credit_redeem: "خصم رصيد في فاتورة",
  credit_refund: "رصيد من مرتجع",
  credit_deduct: "خصم رصيد يدوي",
};

interface WalletEvent {
  id: string;
  kind: string;
  pointsDelta: number;
  creditDelta: number;
  reason: string | null;
  createdAt: string;
}

interface WalletData {
  customerPhone: string;
  customerName: string | null;
  points: number;
  credit: number;
  updatedAt: string;
}

/** Migration 0038. One payment-event row per settle action recorded
 *  against this customer's sales in the active branch. Grouped by
 *  invoiceId in the UI to render a per-invoice timeline. */
interface PaymentEvent {
  id: string;
  saleId: string;
  invoiceId: string | null;
  amount: number;
  method: string;
  recordedAt: string;
  recordedByName: string | null;
}

export default function CustomerDetailPage({
  params,
}: {
  params: Promise<{ phone: string }>;
}) {
  // Next 16 hands params as a Promise — `use()` unwraps in a client comp.
  const { phone } = use(params);
  const decodedPhone = decodeURIComponent(phone);

  const { data: session } = useSession();
  const isOwner = session?.user?.role === "owner";
  const { settings } = useShopSettings();
  const shopName = settings.shopName?.trim() || "متجرنا";
  const loyaltyEnabled = settings.loyaltyEnabled;

  const [ledger, setLedger] = useState<LedgerData | null>(null);
  const [branchName, setBranchName] = useState<string>("");
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [walletEvents, setWalletEvents] = useState<WalletEvent[]>([]);
  const [payments, setPayments] = useState<PaymentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** When non-null the InvoiceSettleModal is open against this invoice. */
  const [settleInvoice, setSettleInvoice] = useState<LedgerInvoice | null>(null);
  const [toast, setToast] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Owner credit-grant form state. Hidden behind a "إضافة رصيد" button.
  const [creditFormOpen, setCreditFormOpen] = useState(false);
  const [creditAmountInput, setCreditAmountInput] = useState("");
  const [creditReasonInput, setCreditReasonInput] = useState("");
  const [creditDeduct, setCreditDeduct] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      // Fetch ledger + wallet in parallel — they're both branch-scoped
      // and the page renders both. Wallet is best-effort (404 just means
      // no transactions yet).
      const encoded = encodeURIComponent(decodedPhone);
      const [ledgerRes, walletRes, paymentsRes] = await Promise.all([
        fetch(`/api/customers/by-phone/${encoded}`, { cache: "no-store" }),
        fetch(`/api/customers/by-phone/${encoded}/wallet`, { cache: "no-store" }),
        fetch(`/api/customers/by-phone/${encoded}/payments`, { cache: "no-store" }),
      ]);
      if (ledgerRes.status === 404) {
        setErr("لا توجد فواتير لهذا العميل في الفرع الحالي.");
        setLedger(null);
      } else if (!ledgerRes.ok) {
        const body = await ledgerRes.json().catch(() => ({}));
        throw new Error(body.error || `request failed (${ledgerRes.status})`);
      } else {
        const json = (await ledgerRes.json()) as ApiResponse;
        setLedger(json.data);
        setBranchName(json.branchName);
      }
      if (walletRes.ok) {
        const json = (await walletRes.json()) as {
          wallet: WalletData;
          events: WalletEvent[];
        };
        setWallet(json.wallet);
        setWalletEvents(json.events);
      }
      if (paymentsRes.ok) {
        const json = (await paymentsRes.json()) as { data: PaymentEvent[] };
        setPayments(json.data ?? []);
      } else {
        setPayments([]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "حدث خطأ");
      setLedger(null);
    } finally {
      setLoading(false);
    }
  }, [decodedPhone]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Bucket the flat payments list by invoiceId so the per-invoice card
  // can render its own timeline without the page doing the filter on
  // every render. Falls back to saleId for legacy rows without a real
  // invoice id. Sorted newest-first inside each bucket.
  const paymentsByInvoice = useMemo(() => {
    const map = new Map<string, PaymentEvent[]>();
    for (const p of payments) {
      const key = p.invoiceId ?? p.saleId;
      const arr = map.get(key) ?? [];
      arr.push(p);
      map.set(key, arr);
    }
    return map;
  }, [payments]);

  // Unused now that the per-invoice modal handles partial collection,
  // but kept as the implementation behind a quick "pay the rest in cash"
  // shortcut if we want to add it back later. The bulk "تأكيد دفع الكل"
  // button uses the dedicated bulk endpoint instead.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const markInvoicePaid = async (inv: LedgerInvoice) => {
    setBusy(true);
    try {
      // Mark every sale row in the invoice. Single-row updates are
      // atomic on the server — there's no all-or-nothing guarantee
      // across rows but a partial result is rare and self-healing on
      // the next refresh.
      await Promise.all(
        inv.saleIds.map((id) =>
          fetch(`/api/sales/${id}/paid`, { method: "POST" }),
        ),
      );
      setToast({
        type: "success",
        message: `تم تأكيد دفع ${formatPrice(inv.total)}`,
      });
      await refresh();
    } catch (e) {
      setToast({
        type: "error",
        message: e instanceof Error ? e.message : "تعذر التحديث",
      });
    } finally {
      setBusy(false);
    }
  };

  const markAllPaid = async () => {
    if (!ledger || ledger.outstandingBalance === 0) return;
    if (
      !window.confirm(
        `سيتم تأكيد دفع كل الفواتير الآجلة (${formatPrice(ledger.outstandingBalance)}). هل أنت متأكد؟`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        `/api/customers/by-phone/${encodeURIComponent(decodedPhone)}/mark-all-paid`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `request failed (${res.status})`);
      }
      const json = (await res.json()) as {
        markedCount: number;
        markedTotal: number;
      };
      setToast({
        type: "success",
        message: `تم تأكيد دفع ${json.markedCount} فاتورة (${formatPrice(json.markedTotal)})`,
      });
      await refresh();
    } catch (e) {
      setToast({
        type: "error",
        message: e instanceof Error ? e.message : "تعذر التحديث",
      });
    } finally {
      setBusy(false);
    }
  };

  // WhatsApp reminder messages — per-invoice reads the actual amount + id;
  // bulk reminder summarises the outstanding total. Both substitute the
  // current branch's shop name from settings (was hardcoded "Corner Store"
  // pre-customer-ledger).
  const waLink = useCallback(
    (text: string) => {
      const cleaned = decodedPhone.replace(/\D/g, "");
      return cleaned
        ? `https://wa.me/${cleaned}?text=${encodeURIComponent(text)}`
        : `https://wa.me/?text=${encodeURIComponent(text)}`;
    },
    [decodedPhone],
  );

  const customerLabel =
    ledger?.customerName?.trim() ||
    decodedPhone ||
    "عميل";

  const reminderMsgInvoice = (inv: LedgerInvoice) =>
    `أهلاً ${customerLabel}،\nتذكير بفاتورة رقم ${inv.invoiceId} بتاريخ ${formatDate(new Date(inv.date))} بقيمة ${formatPrice(inv.total)} عندك في ${shopName}. شكراً!`;

  const reminderMsgBulk = useMemo(() => {
    if (!ledger || ledger.outstandingBalance === 0) return "";
    const unpaid = ledger.invoices.filter((i) => !i.isPaid);
    return `أهلاً ${customerLabel}،\nعندك ${unpaid.length} فاتورة آجلة بإجمالي ${formatPrice(ledger.outstandingBalance)} في ${shopName}. شكراً لتعاملك معنا.`;
  }, [ledger, customerLabel, shopName]);

  const grantCreditSubmit = async () => {
    const amount = Number(creditAmountInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      setToast({ type: "error", message: "أدخل مبلغاً صحيحاً" });
      return;
    }
    if (!creditReasonInput.trim()) {
      setToast({ type: "error", message: "السبب مطلوب" });
      return;
    }
    const signed = creditDeduct ? -amount : amount;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/customers/by-phone/${encodeURIComponent(decodedPhone)}/credit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amountEgp: signed,
            reason: creditReasonInput.trim(),
            customerName: ledger?.customerName ?? undefined,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `request failed (${res.status})`);
      }
      setToast({
        type: "success",
        message: creditDeduct
          ? `تم خصم ${formatPrice(amount)} من رصيد العميل`
          : `تم إضافة ${formatPrice(amount)} لرصيد العميل`,
      });
      setCreditAmountInput("");
      setCreditReasonInput("");
      setCreditFormOpen(false);
      setCreditDeduct(false);
      await refresh();
    } catch (e) {
      setToast({
        type: "error",
        message: e instanceof Error ? e.message : "تعذر التحديث",
      });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <AppShell title="تفاصيل العميل">
        <PageSkeleton rows={6} />
      </AppShell>
    );
  }

  if (err && !ledger) {
    return (
      <AppShell title="تفاصيل العميل">
        <BackLink />
        <EmptyState type="sales" message={err} />
      </AppShell>
    );
  }

  if (!ledger) {
    return (
      <AppShell title="تفاصيل العميل">
        <BackLink />
        <EmptyState type="sales" message="لا توجد بيانات." />
      </AppShell>
    );
  }

  const hasDebt = ledger.outstandingBalance > 0;

  return (
    <AppShell title={customerLabel}>
      <div className="space-y-5">
        <BackLink />

        {/* Header card */}
        <div className="bg-white rounded-2xl border border-border p-5 space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-text-primary truncate">
                {customerLabel}
              </h1>
              {ledger.customerPhone && (
                <p className="text-sm text-text-secondary mt-1 flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5" />
                  {ledger.customerPhone}
                </p>
              )}
              {branchName && (
                <p className="text-[11px] text-text-secondary mt-1">
                  بيانات الفرع: {branchName}
                </p>
              )}
            </div>
            {hasDebt && (
              <div className="text-end">
                <p className="text-[10px] text-text-secondary uppercase tracking-wider">
                  متبقي من العميل
                </p>
                <p className="text-2xl font-extrabold text-orange-600 tabular-nums">
                  {formatPrice(ledger.outstandingBalance)}
                </p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-border">
            <Stat
              icon={<Wallet className="w-4 h-4" />}
              label="إجمالي الإنفاق"
              value={formatPrice(ledger.lifetimeValue)}
            />
            <Stat
              icon={<CheckCircle className="w-4 h-4 text-success" />}
              label="مدفوع"
              value={formatPrice(ledger.paidBalance)}
            />
            <Stat
              icon={<Receipt className="w-4 h-4" />}
              label="عدد الفواتير"
              value={String(ledger.invoiceCount)}
            />
            <Stat
              icon={<Calendar className="w-4 h-4" />}
              label="آخر زيارة"
              value={ledger.lastVisit ? formatDate(new Date(ledger.lastVisit)) : "—"}
            />
          </div>

          {hasDebt && (
            <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-border">
              <Button onClick={markAllPaid} disabled={busy}>
                <CheckCircle className="w-4 h-4 me-1" />
                تأكيد دفع الكل
              </Button>
              {ledger.customerPhone && (
                <a
                  href={waLink(reminderMsgBulk)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-orange-100 text-orange-700 text-sm font-medium hover:bg-orange-200 transition-colors"
                >
                  <Bell className="w-4 h-4" />
                  تذكير بكل الآجل
                </a>
              )}
              {ledger.customerPhone && (
                <a
                  href={waLink(
                    `أهلاً ${customerLabel}، شكراً لتسوقك من ${shopName} ❤️`,
                  )}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-success-light text-success text-sm font-medium hover:bg-success hover:text-white transition-colors"
                >
                  <MessageCircle className="w-4 h-4" />
                  رسالة شكر
                </a>
              )}
            </div>
          )}
        </div>

        {/* Wallet card — points + credit + history. Always visible when
            the customer has any wallet activity OR loyalty is enabled
            (so the owner can grant credit before the customer earns
            anything). Hidden entirely on stores where loyalty is off
            and the wallet has zero history, to avoid clutter. */}
        {(loyaltyEnabled ||
          (wallet && (wallet.points > 0 || wallet.credit > 0)) ||
          walletEvents.length > 0) && (
          <div className="bg-white rounded-2xl border border-border overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Wallet className="w-4 h-4 text-text-secondary" />
                <h2 className="text-sm font-semibold text-text-primary">
                  محفظة العميل
                </h2>
              </div>
              {isOwner && !creditFormOpen && (
                <button
                  type="button"
                  onClick={() => setCreditFormOpen(true)}
                  className="text-xs text-accent hover:underline inline-flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  إضافة / خصم رصيد
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 divide-x divide-border [direction:rtl]">
              <div className="p-5 text-center">
                <Star className="w-5 h-5 text-orange-500 mx-auto mb-1" />
                <p className="text-2xl font-extrabold text-text-primary tabular-nums">
                  {wallet?.points ?? 0}
                </p>
                <p className="text-[10px] text-text-secondary uppercase tracking-wider mt-0.5">
                  نقاط
                </p>
                {loyaltyEnabled &&
                  settings.loyaltyEgpPerPoint > 0 &&
                  (wallet?.points ?? 0) > 0 && (
                    <p className="text-[11px] text-accent mt-1">
                      = {formatPrice(
                        (wallet?.points ?? 0) * settings.loyaltyEgpPerPoint,
                      )}{" "}
                      خصم محتمل
                    </p>
                  )}
              </div>
              <div className="p-5 text-center">
                <Wallet className="w-5 h-5 text-success mx-auto mb-1" />
                <p className="text-2xl font-extrabold text-text-primary tabular-nums">
                  {formatPrice(wallet?.credit ?? 0)}
                </p>
                <p className="text-[10px] text-text-secondary uppercase tracking-wider mt-0.5">
                  رصيد
                </p>
              </div>
            </div>

            {creditFormOpen && (
              <div className="px-5 py-4 border-t border-border bg-bg-main/30 space-y-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCreditDeduct(false)}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      !creditDeduct
                        ? "bg-success-light text-success border-success/30"
                        : "bg-white border-border text-text-secondary"
                    }`}
                  >
                    <Plus className="w-3.5 h-3.5 inline-block me-1" />
                    إضافة
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreditDeduct(true)}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      creditDeduct
                        ? "bg-danger-light text-danger border-danger/30"
                        : "bg-white border-border text-text-secondary"
                    }`}
                  >
                    <Minus className="w-3.5 h-3.5 inline-block me-1" />
                    خصم
                  </button>
                </div>
                <Input
                  label="المبلغ بالجنيه"
                  type="number"
                  min="0"
                  step="0.01"
                  value={creditAmountInput}
                  onChange={(e) => setCreditAmountInput(e.target.value)}
                  placeholder="0"
                />
                <Input
                  label="السبب"
                  value={creditReasonInput}
                  onChange={(e) => setCreditReasonInput(e.target.value)}
                  placeholder="مثال: تعويض عن منتج معطوب"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setCreditFormOpen(false);
                      setCreditAmountInput("");
                      setCreditReasonInput("");
                      setCreditDeduct(false);
                    }}
                    disabled={busy}
                    className="text-sm text-text-secondary hover:text-text-primary px-3 py-2"
                  >
                    إلغاء
                  </button>
                  <Button
                    onClick={grantCreditSubmit}
                    disabled={busy}
                    loading={busy}
                  >
                    حفظ
                  </Button>
                </div>
              </div>
            )}

            {walletEvents.length > 0 && (
              <div className="border-t border-border">
                <p className="px-5 py-2 text-[10px] text-text-secondary uppercase tracking-wider bg-bg-main/30">
                  آخر العمليات
                </p>
                <ul className="divide-y divide-border max-h-[280px] overflow-y-auto">
                  {walletEvents.slice(0, 20).map((ev) => (
                    <li
                      key={ev.id}
                      className="px-5 py-2.5 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-text-primary">
                          {WALLET_EVENT_LABELS[ev.kind] ?? ev.kind}
                        </p>
                        <p className="text-[10px] text-text-secondary mt-0.5">
                          {formatDate(new Date(ev.createdAt))}
                          {ev.reason && ` · ${ev.reason}`}
                        </p>
                      </div>
                      <div className="text-end shrink-0 tabular-nums">
                        {ev.pointsDelta !== 0 && (
                          <p
                            className={
                              ev.pointsDelta > 0 ? "text-success" : "text-danger"
                            }
                          >
                            {ev.pointsDelta > 0 ? "+" : ""}
                            {ev.pointsDelta} نقطة
                          </p>
                        )}
                        {ev.creditDelta !== 0 && (
                          <p
                            className={
                              ev.creditDelta > 0 ? "text-success" : "text-danger"
                            }
                          >
                            {ev.creditDelta > 0 ? "+" : ""}
                            {formatPrice(ev.creditDelta)}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Invoice list */}
        <div className="bg-white rounded-2xl border border-border overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center gap-2">
            <Receipt className="w-4 h-4 text-text-secondary" />
            <h2 className="text-sm font-semibold text-text-primary">
              سجل الفواتير
            </h2>
          </div>
          <ul className="divide-y divide-border">
            {ledger.invoices.map((inv) => (
              <li
                key={inv.invoiceId}
                className={`p-5 ${!inv.isPaid ? "bg-orange-50/40" : ""}`}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm text-text-primary">
                        {inv.invoiceId}
                      </span>
                      {/* Three-state chip — fully paid / partial / fully on
                          account. The middle case is the new partial-pay
                          flow (e.g. customer paid 1000 of 1300). */}
                      {inv.isPaid ? (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-success-light text-success font-medium">
                          مدفوع
                        </span>
                      ) : inv.amountPaid > 0 ? (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">
                          جزئي
                        </span>
                      ) : (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-medium">
                          آجل
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-text-secondary mt-1">
                      {formatDate(new Date(inv.date))} · {inv.lines.length} قطعة
                      {inv.paidAt && (
                        <span className="ms-2">
                          · دُفع {formatDate(new Date(inv.paidAt))}
                        </span>
                      )}
                    </p>
                    <ul className="mt-2 space-y-0.5">
                      {inv.lines.map((l) => (
                        <li
                          key={l.saleId}
                          className="text-xs text-text-secondary flex items-center justify-between gap-2"
                        >
                          <span className="truncate">
                            {l.productName} ×{l.quantity}
                          </span>
                          <span className="tabular-nums shrink-0">
                            {formatPrice(l.lineTotal)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="text-end shrink-0">
                    {/* Layout: total at the top (always shown), with a
                        compact "Paid / Remaining" pair below when the
                        invoice is partial-paid. Fully-paid and fully-
                        unpaid invoices stay clean — no extra noise. */}
                    <p className="text-lg font-bold text-text-primary tabular-nums">
                      {formatPrice(inv.total)}
                    </p>
                    {!inv.isPaid && inv.amountPaid > 0 && (
                      <div className="mt-1 text-[11px] leading-tight space-y-0.5">
                        <p className="text-success tabular-nums">
                          مدفوع: {formatPrice(inv.amountPaid)}
                        </p>
                        <p className="font-semibold text-orange-700 tabular-nums">
                          متبقي: {formatPrice(inv.balance)}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {!inv.isPaid && (
                  <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-border">
                    <button
                      type="button"
                      onClick={() => setSettleInvoice(inv)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-success text-white text-xs font-medium hover:bg-success/90 disabled:opacity-50"
                    >
                      <CheckCircle className="w-3.5 h-3.5" />
                      تسجيل دفعة
                    </button>
                    {ledger.customerPhone && (
                      <a
                        href={waLink(reminderMsgInvoice(inv))}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-orange-100 text-orange-700 text-xs font-medium hover:bg-orange-200"
                      >
                        <Bell className="w-3.5 h-3.5" />
                        تذكير
                      </a>
                    )}
                  </div>
                )}

                {/* Per-invoice payment timeline — Migration 0038. We show
                    the date + amount + method for every recorded payment
                    against this invoice. Empty for fully-unpaid آجل rows
                    that haven't received anything yet. */}
                {(() => {
                  const events = paymentsByInvoice.get(inv.invoiceId) ?? [];
                  if (events.length === 0) return null;
                  return (
                    <div className="mt-3 pt-3 border-t border-border">
                      <p className="text-[10px] uppercase tracking-wider text-text-secondary mb-1.5">
                        سجل الدفعات
                      </p>
                      <ul className="space-y-1">
                        {events.map((p) => {
                          const methodLabel =
                            p.method === "cash"
                              ? "كاش"
                              : p.method === "instapay"
                                ? "إنستا باي"
                                : p.method === "card"
                                  ? "كارت"
                                  : "دفعة سابقة";
                          const methodCls =
                            p.method === "cash"
                              ? "bg-success-light text-success"
                              : p.method === "initial"
                                ? "bg-bg-main text-text-secondary"
                                : "bg-accent-light text-accent";
                          return (
                            <li
                              key={p.id}
                              className="flex items-center justify-between gap-2 text-xs"
                            >
                              <div className="min-w-0 flex items-center gap-2 flex-wrap">
                                <span className="text-text-secondary">
                                  {formatDate(new Date(p.recordedAt))}
                                </span>
                                <span
                                  className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${methodCls}`}
                                >
                                  {methodLabel}
                                </span>
                                {p.recordedByName && (
                                  <span className="text-[10px] text-text-secondary/80 truncate">
                                    {p.recordedByName}
                                  </span>
                                )}
                              </div>
                              <span className="font-bold text-success tabular-nums shrink-0">
                                {formatPrice(p.amount)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })()}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          onClose={() => setToast(null)}
        />
      )}

      <InvoiceSettleModal
        invoice={
          settleInvoice
            ? {
                invoiceId: settleInvoice.invoiceId,
                total: settleInvoice.total,
                amountPaid: settleInvoice.amountPaid,
                balance: settleInvoice.balance,
              }
            : null
        }
        customerPhone={decodedPhone}
        onClose={() => setSettleInvoice(null)}
        onSettled={async (collected) => {
          setSettleInvoice(null);
          setToast({
            type: "success",
            message: `تم تسجيل ${formatPrice(collected)}`,
          });
          await refresh();
        }}
      />
    </AppShell>
  );
}

function BackLink() {
  return (
    <Link
      href="/customers"
      className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-accent transition-colors"
    >
      <ChevronRight className="w-4 h-4" />
      العملاء
    </Link>
  );
}

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
    <div>
      <div className="flex items-center gap-1.5 text-text-secondary text-[10px] uppercase tracking-wider">
        {icon}
        {label}
      </div>
      <p className="text-sm font-bold text-text-primary mt-0.5 tabular-nums">
        {value}
      </p>
    </div>
  );
}
