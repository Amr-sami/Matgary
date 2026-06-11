"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Toast } from "@/components/ui/Toast";
import { Wallet } from "@/lib/icons";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";
import type { CustomerAggregate } from "@/lib/customers";
import type { CustomerSaleRecord } from "@/hooks/useCustomersData";

type SettlementMethod = "cash" | "instapay" | "card";

interface Props {
  /** Active debtor — when non-null the modal is open. */
  customer: CustomerAggregate | null;
  /** Full sales feed (same one driving the customers page). We filter it
   *  down to this customer's unpaid lines for the per-invoice picker. */
  records: CustomerSaleRecord[];
  onClose: () => void;
  onSettled: () => void | Promise<void>;
}

interface UnpaidInvoice {
  invoiceId: string;
  total: number;
  paid: number;
  balance: number;
  oldestDate: Date;
}

/**
 * Per-invoice settlement modal. Shows the customer's unpaid invoices
 * oldest-first; the cashier enters an amount + method and either lets us
 * auto-apply oldest-first (default) or hand-picks specific invoices.
 *
 * Sends POST /api/sales/settle which returns the applied amount, count of
 * fully-settled invoices, and the customer's new balance. Cash settlements
 * are stamped on the active cash shift server-side.
 */
export function CustomerSettleModal({
  customer,
  records,
  onClose,
  onSettled,
}: Props) {
  const dict = useDictionary();
  const locale = useLocale();
  // Defensive cast: in dev, hot-reloading the JSON dictionaries while the
  // bundle is mid-render can hand us a stale `dict` reference where the
  // newly-added `settle` block is undefined. Guarding here keeps the
  // global error boundary from catching the throw — see /customers
  // 2026-06-11 ticket. Restart the dev server once if you keep hitting
  // the null branch.
  const t = dict.app.customers.settle as
    | typeof dict.app.customers.settle
    | undefined;

  // Roll up the records into one row per unpaid invoice for this customer.
  // We need totals (not per-line) so the cashier picks "this invoice" not
  // "this line of this invoice".
  const unpaidInvoices = useMemo<UnpaidInvoice[]>(() => {
    if (!customer) return [];
    const phone = customer.phone;
    if (!phone) return [];
    const byInvoice = new Map<string, UnpaidInvoice>();
    for (const r of records) {
      if (r.isReturned) continue;
      if (r.customerPhone !== phone) continue;
      const paid = r.amountPaid ?? (r.isPaid ? r.totalPrice : 0);
      const balance = r.totalPrice - paid;
      if (balance <= 0) continue;
      const invoiceId = r.invoiceId ?? r.id;
      const prev = byInvoice.get(invoiceId);
      if (prev) {
        prev.total += r.totalPrice;
        prev.paid += paid;
        prev.balance += balance;
        if (r.saleDate < prev.oldestDate) prev.oldestDate = r.saleDate;
      } else {
        byInvoice.set(invoiceId, {
          invoiceId,
          total: r.totalPrice,
          paid,
          balance,
          oldestDate: r.saleDate,
        });
      }
    }
    return Array.from(byInvoice.values()).sort(
      (a, b) => a.oldestDate.getTime() - b.oldestDate.getTime(),
    );
  }, [customer, records]);

  const [amountInput, setAmountInput] = useState("");
  const [method, setMethod] = useState<SettlementMethod>("cash");
  /** Empty set = "apply oldest first" (default); a non-empty set means the
   *  cashier hand-picked invoices. */
  const [pickedInvoices, setPickedInvoices] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Reset transient state every time the modal opens against a new customer.
  useEffect(() => {
    if (customer) {
      setAmountInput("");
      setMethod("cash");
      setPickedInvoices(new Set());
    }
  }, [customer?.key]);

  // If the dict block hasn't hot-reloaded yet, render only the (potentially
  // pending) toast and skip the modal — avoids crashing the page tree.
  if (!t) {
    if (process.env.NODE_ENV !== "production" && customer) {
      // Surfaced as a one-time warning so the cause is obvious.
      console.warn(
        "[CustomerSettleModal] dict.app.customers.settle is undefined — restart the dev server to pick up the new dictionary keys.",
      );
    }
    return toast ? (
      <Toast
        type={toast.type}
        message={toast.message}
        onClose={() => setToast(null)}
      />
    ) : null;
  }

  // Toast outlives the modal-open guard so success notifications still show
  // after the modal closes.
  const toastEl = toast ? (
    <Toast
      type={toast.type}
      message={toast.message}
      onClose={() => setToast(null)}
    />
  ) : null;

  if (!customer) return toastEl;

  const togglePick = (invoiceId: string) => {
    setPickedInvoices((prev) => {
      const next = new Set(prev);
      if (next.has(invoiceId)) next.delete(invoiceId);
      else next.add(invoiceId);
      return next;
    });
  };

  // When the cashier hand-picks invoices, default the amount to the sum
  // of their balances. They can still type a partial amount.
  const pickedTotal = useMemo(
    () =>
      unpaidInvoices
        .filter((inv) => pickedInvoices.has(inv.invoiceId))
        .reduce((s, inv) => s + inv.balance, 0),
    [unpaidInvoices, pickedInvoices],
  );

  const amount = Math.max(0, Number(amountInput) || 0);
  const balance = customer.outstandingBalance;
  const wouldOverpay = amount > balance;

  const handleSubmit = async () => {
    if (!customer.phone) return;
    if (amount <= 0) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/sales/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerPhone: customer.phone,
          amount,
          method,
          invoiceIds:
            pickedInvoices.size > 0
              ? Array.from(pickedInvoices)
              : undefined,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        const errorMap = t.errors as Record<string, string>;
        setToast({
          type: "error",
          message: (j.error && errorMap[j.error]) || t.errors.GENERIC,
        });
        return;
      }
      const json = (await res.json()) as {
        appliedAmount: number;
        overpay: number;
        fullySettledInvoices: number;
        newBalance: number;
      };
      setToast({
        type: "success",
        message: t.success
          .replace("{amount}", formatCurrency(json.appliedAmount, locale))
          .replace("{count}", String(json.fullySettledInvoices))
          .replace("{balance}", formatCurrency(json.newBalance, locale)),
      });
      await onSettled();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Modal
        isOpen
        onClose={onClose}
        title={t.title}
        className="max-w-lg"
      >
        <div className="space-y-4">
          {/* Customer header — name, phone, owed amount */}
          <div className="flex items-start justify-between gap-3 p-3 rounded-lg bg-orange-50 border border-orange-200">
            <div className="min-w-0">
              <p className="font-semibold text-text-primary truncate" dir="auto">
                {customer.name}
              </p>
              {customer.phone && (
                <p className="text-xs text-text-secondary" dir="ltr">
                  {customer.phone}
                </p>
              )}
            </div>
            <div className="text-end shrink-0">
              <p className="text-[10px] text-orange-700 uppercase tracking-wider">
                {t.balanceLabel}
              </p>
              <p className="text-lg font-extrabold text-orange-900">
                {formatCurrency(balance, locale)}
              </p>
            </div>
          </div>

          {/* Amount + method */}
          <div className="space-y-3">
            <label className="block">
              <span className="block text-xs font-medium text-text-secondary mb-1">
                {t.amountLabel}
              </span>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={0}
                  max={balance}
                  step="0.01"
                  inputMode="decimal"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  placeholder="0"
                  dir="ltr"
                  className="flex-1 px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <button
                  type="button"
                  onClick={() =>
                    setAmountInput(
                      String(pickedInvoices.size > 0 ? pickedTotal : balance),
                    )
                  }
                  className="shrink-0 px-3 py-2 rounded-lg border border-accent text-accent text-xs font-semibold hover:bg-accent-light"
                >
                  {t.payAllShort}
                </button>
              </div>
              {wouldOverpay && (
                <p className="text-[11px] text-danger mt-1">
                  {t.overpayHint}
                </p>
              )}
            </label>

            <div>
              <span className="block text-xs font-medium text-text-secondary mb-1">
                {t.methodLabel}
              </span>
              <div className="grid grid-cols-3 gap-2">
                {(["cash", "instapay", "card"] as SettlementMethod[]).map(
                  (m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMethod(m)}
                      className={`py-2 rounded-lg text-sm font-semibold transition-colors border ${
                        method === m
                          ? "bg-accent text-white border-accent"
                          : "bg-white text-text-secondary border-border hover:border-accent/50"
                      }`}
                    >
                      {t.methods[m]}
                    </button>
                  ),
                )}
              </div>
            </div>
          </div>

          {/* Per-invoice picker — collapsed by default to keep the modal
              compact. The cashier ticks an invoice to settle only that
              one; leaving them all empty means "apply oldest-first". */}
          {unpaidInvoices.length > 0 && (
            <details className="rounded-lg border border-border">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-text-secondary flex items-center justify-between">
                <span>
                  {pickedInvoices.size > 0
                    ? t.invoicePicker.picked.replace(
                        "{n}",
                        String(pickedInvoices.size),
                      )
                    : t.invoicePicker.oldestFirst.replace(
                        "{n}",
                        String(unpaidInvoices.length),
                      )}
                </span>
                <span className="text-[11px] font-normal text-accent">
                  {t.invoicePicker.toggle}
                </span>
              </summary>
              <ul className="max-h-48 overflow-y-auto divide-y divide-border">
                {unpaidInvoices.map((inv) => {
                  const isPicked = pickedInvoices.has(inv.invoiceId);
                  return (
                    <li key={inv.invoiceId}>
                      <label className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-bg-main">
                        <input
                          type="checkbox"
                          checked={isPicked}
                          onChange={() => togglePick(inv.invoiceId)}
                          className="w-4 h-4 accent-accent"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="font-mono text-[11px] truncate" dir="ltr">
                            {inv.invoiceId}
                          </p>
                          <p className="text-[10px] text-text-secondary">
                            {inv.oldestDate.toLocaleDateString(
                              locale === "ar" ? "ar-EG" : "en-US",
                            )}
                          </p>
                        </div>
                        <div className="text-end shrink-0">
                          <p className="font-semibold text-orange-700">
                            {formatCurrency(inv.balance, locale)}
                          </p>
                          {inv.paid > 0 && (
                            <p className="text-[10px] text-text-secondary">
                              {t.invoicePicker.paid.replace(
                                "{amount}",
                                formatCurrency(inv.paid, locale),
                              )}
                            </p>
                          )}
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}

          {/* Actions */}
          <div className="flex gap-2 justify-end pt-2 border-t border-border">
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              {t.cancel}
            </Button>
            <Button
              onClick={handleSubmit}
              loading={submitting}
              disabled={amount <= 0 || wouldOverpay || !customer.phone}
            >
              <Wallet className="w-4 h-4 me-1" />
              {t.submit}
            </Button>
          </div>
        </div>
      </Modal>
      {toastEl}
    </>
  );
}
