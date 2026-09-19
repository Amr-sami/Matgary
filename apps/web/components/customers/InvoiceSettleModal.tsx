"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Wallet } from "@/lib/icons";
import { formatPrice, formatDate } from "@/lib/utils";

type Method = "cash" | "instapay" | "card";

interface PaymentEvent {
  id: string;
  amount: number;
  method: string;
  recordedAt: string;
  recordedByName: string | null;
}

interface Props {
  /** Invoice being settled. Modal is open while non-null. */
  invoice: {
    invoiceId: string;
    total: number;
    amountPaid: number;
    balance: number;
  } | null;
  /** Normalised customer phone — passed to the settle endpoint. */
  customerPhone: string;
  onClose: () => void;
  onSettled: (collected: number) => void | Promise<void>;
}

const METHOD_LABEL: Record<Method, string> = {
  cash: "كاش",
  instapay: "إنستا باي",
  card: "كارت",
};

const METHOD_BADGE: Record<string, { label: string; cls: string }> = {
  cash: { label: "كاش", cls: "bg-success-light text-success" },
  instapay: { label: "إنستا باي", cls: "bg-accent-light text-accent" },
  card: { label: "كارت", cls: "bg-accent-light text-accent" },
  initial: { label: "دفعة سابقة", cls: "bg-bg-main text-text-secondary" },
};

/**
 * Per-invoice "تسجيل دفعة" modal. Lets the cashier take a partial amount
 * (defaults to the remaining balance, capped at it), pick a method, and
 * submit. Calls /api/sales/settle scoped to this single invoice via
 * `invoiceIds=[inv.invoiceId]`.
 *
 * Shows the invoice's prior payment events at the top so the cashier can
 * confirm what's already on file before adding a new line.
 */
export function InvoiceSettleModal({
  invoice,
  customerPhone,
  onClose,
  onSettled,
}: Props) {
  const [amountInput, setAmountInput] = useState("");
  const [method, setMethod] = useState<Method>("cash");
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState<PaymentEvent[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset + load history when the modal opens against a new invoice.
  useEffect(() => {
    if (!invoice) return;
    setAmountInput(invoice.balance > 0 ? String(invoice.balance) : "");
    setMethod("cash");
    setError(null);
    setLoadingHistory(true);
    const url = `/api/customers/by-phone/${encodeURIComponent(
      customerPhone,
    )}/payments?invoiceId=${encodeURIComponent(invoice.invoiceId)}`;
    fetch(url, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          setHistory([]);
          return;
        }
        const json = (await res.json()) as { data: PaymentEvent[] };
        setHistory(json.data ?? []);
      })
      .catch(() => setHistory([]))
      .finally(() => setLoadingHistory(false));
  }, [invoice?.invoiceId, customerPhone]);

  const amount = useMemo(
    () => Math.max(0, Math.min(Number(amountInput) || 0, invoice?.balance ?? 0)),
    [amountInput, invoice?.balance],
  );
  const wouldOverpay = invoice ? Number(amountInput) > invoice.balance : false;

  if (!invoice) return null;

  const submit = async () => {
    if (amount <= 0) {
      setError("أدخل مبلغ أكبر من صفر");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/sales/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerPhone,
          amount,
          method,
          invoiceIds: [invoice.invoiceId],
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        // Prefer the server's detail message over the bare error code so
        // the cashier sees something actionable (e.g. "amount exceeds
        // balance") rather than "INTERNAL".
        setError(j.detail || j.error || "تعذر تسجيل الدفعة");
        return;
      }
      const json = (await res.json()) as { appliedAmount: number };
      await onSettled(json.appliedAmount);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`تسجيل دفعة — ${invoice.invoiceId}`}>
      <div className="space-y-4">
        {/* Invoice snapshot */}
        <div className="grid grid-cols-3 gap-2 p-3 rounded-lg bg-bg-main border border-border text-center">
          <div>
            <p className="text-[10px] text-text-secondary uppercase tracking-wider">
              إجمالي
            </p>
            <p className="text-sm font-bold text-text-primary tabular-nums mt-0.5">
              {formatPrice(invoice.total)}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-text-secondary uppercase tracking-wider">
              مدفوع
            </p>
            <p className="text-sm font-bold text-success tabular-nums mt-0.5">
              {formatPrice(invoice.amountPaid)}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-text-secondary uppercase tracking-wider">
              متبقي
            </p>
            <p className="text-sm font-bold text-orange-700 tabular-nums mt-0.5">
              {formatPrice(invoice.balance)}
            </p>
          </div>
        </div>

        {/* Amount + method */}
        <div className="space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-text-secondary mb-1">
              المبلغ المستلم
            </span>
            <div className="flex gap-2">
              <input
                type="number"
                min={0}
                max={invoice.balance}
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
                onClick={() => setAmountInput(String(invoice.balance))}
                className="shrink-0 px-3 py-2 rounded-lg border border-accent text-accent text-xs font-semibold hover:bg-accent-light"
              >
                دفع الباقي
              </button>
            </div>
            {wouldOverpay && (
              <p className="text-[11px] text-danger mt-1">
                المبلغ أكبر من المتبقي. هنسجل {formatPrice(invoice.balance)} فقط.
              </p>
            )}
          </label>

          <div>
            <span className="block text-xs font-medium text-text-secondary mb-1">
              طريقة الدفع
            </span>
            <div className="grid grid-cols-3 gap-2">
              {(["cash", "instapay", "card"] as Method[]).map((m) => (
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
                  {METHOD_LABEL[m]}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Prior payments timeline */}
        <details
          className="rounded-lg border border-border"
          open={history.length > 0}
        >
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-text-secondary flex items-center justify-between">
            <span>
              سجل الدفعات السابقة
              {history.length > 0 && (
                <span className="ms-1 text-accent">({history.length})</span>
              )}
            </span>
            <span className="text-[11px] font-normal text-accent">
              {loadingHistory ? "جارٍ التحميل…" : "عرض"}
            </span>
          </summary>
          {history.length === 0 ? (
            <p className="px-3 py-3 text-[11px] text-text-secondary italic">
              لا توجد دفعات سابقة على هذه الفاتورة بعد.
            </p>
          ) : (
            <ul className="max-h-48 overflow-y-auto divide-y divide-border">
              {history.map((p) => {
                const badge = METHOD_BADGE[p.method] ?? {
                  label: p.method,
                  cls: "bg-bg-main text-text-secondary",
                };
                return (
                  <li
                    key={p.id}
                    className="px-3 py-2 flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="text-text-secondary">
                        {formatDate(new Date(p.recordedAt))}
                      </p>
                      {p.recordedByName && (
                        <p className="text-[10px] text-text-secondary/80 truncate">
                          {p.recordedByName}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                      <span className="font-bold text-success tabular-nums">
                        {formatPrice(p.amount)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </details>

        {error && (
          <p className="text-xs text-danger bg-danger-light px-3 py-2 rounded-lg">
            {error}
          </p>
        )}

        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            إلغاء
          </Button>
          <Button onClick={submit} loading={submitting} disabled={amount <= 0}>
            <Wallet className="w-4 h-4 me-1" />
            تسجيل {formatPrice(amount)}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
