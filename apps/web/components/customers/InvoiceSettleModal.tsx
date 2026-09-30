"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Wallet } from "@/lib/icons";
import { formatPrice, formatDate } from "@/lib/utils";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { invalidateAfterDecision, useCollectionsAccess } from "@/hooks/useCollections";
import { useCollectionAccounts } from "@/hooks/useCollectionAccounts";
import { TransferPanel } from "@/components/collections/TransferPanel";
import { CollectionPill } from "@/components/collections/CollectionPill";
import { errorCopy } from "@/components/collections/copy";
import { newIdempotencyKey } from "@/lib/api/collections";
import {
  EMPTY_TRANSFER,
  accountsForMethod,
  collectionOptionsFromDraft,
  isDigital,
  paymentEventView,
  settleMethodsFor,
  validateTransfer,
  type SettleMethod,
  type TransferDraft,
} from "@/components/collections/rules";

interface PaymentEvent {
  id: string;
  amount: number;
  method: string;
  recordedAt: string;
  recordedByName: string | null;
  /** Digital collections (05 §4.13): the transfer behind this payment. */
  collectionId?: string | null;
  /** Set when the transfer was rejected: the payment no longer counts. */
  voidedAt?: string | null;
  collectionStatus?: string | null;
}

export interface SettleResult {
  collected: number;
  /** "pending" for a digital settle awaiting the owner's confirmation. */
  collectionStatus: "pending" | null;
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
  onSettled: (result: SettleResult) => void | Promise<void>;
}

const HISTORY_TONE: Record<string, string> = {
  cash: "bg-success-light text-success",
  initial: "bg-bg-main text-text-secondary",
};

/**
 * Per-invoice "record a payment" modal. Lets the cashier take a partial
 * amount (defaults to the remaining balance, capped at it), pick a method,
 * and submit. Calls /api/sales/settle scoped to this single invoice via
 * `invoiceIds=[inv.invoiceId]`.
 *
 * Digital collections (doc 15 spec 12 §4.6): with the feature on, `wallet`
 * joins the methods and InstaPay / wallet show the receiving-account picker
 * + payer hints; the payment then books as "awaiting confirmation". One
 * Idempotency-Key per opened invoice, reused on every retry, so a lost
 * response never records the payment twice.
 *
 * Shows the invoice's prior payment events so the cashier can confirm
 * what's already on file before adding a new line.
 */
export function InvoiceSettleModal(props: Props) {
  // One body per opened invoice: amount, method, transfer draft, history and
  // the Idempotency-Key all start fresh (and the key survives every retry
  // while this invoice's modal stays open).
  if (!props.invoice) return null;
  return <SettleBody key={props.invoice.invoiceId} {...props} invoice={props.invoice} />;
}

function SettleBody({
  invoice,
  customerPhone,
  onClose,
  onSettled,
}: Props & { invoice: NonNullable<Props["invoice"]> }) {
  const dict = useDictionary();
  const t = dict.app.collections.web.settle;
  const qc = useQueryClient();
  const { features, config, canManage } = useCollectionsAccess();
  const collectionsOn = features.collections;
  const {
    accounts,
    branchId: accountsBranchId,
    state: accountsState,
  } = useCollectionAccounts({ enabled: collectionsOn });

  const [amountInput, setAmountInput] = useState(() => (invoice.balance > 0 ? String(invoice.balance) : ""));
  const [pickedMethod, setMethod] = useState<SettleMethod>("cash");
  // The feature flipped off while `wallet` was picked → cash.
  const method: SettleMethod = !collectionsOn && pickedMethod === "wallet" ? "cash" : pickedMethod;
  const [transfer, setTransfer] = useState<TransferDraft>(EMPTY_TRANSFER);
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState<PaymentEvent[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(newIdempotencyKey);

  // The invoice's earlier payments.
  useEffect(() => {
    const url = `/api/customers/by-phone/${encodeURIComponent(
      customerPhone,
    )}/payments?invoiceId=${encodeURIComponent(invoice.invoiceId)}`;
    let cancelled = false;
    fetch(url, { cache: "no-store" })
      .then(async (res) => {
        const json = res.ok ? ((await res.json()) as { data: PaymentEvent[] }) : { data: [] };
        if (!cancelled) setHistory(json.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [invoice.invoiceId, customerPhone]);

  const amount = useMemo(
    () => Math.max(0, Math.min(Number(amountInput) || 0, invoice.balance)),
    [amountInput, invoice.balance],
  );
  const wouldOverpay = Number(amountInput) > invoice.balance;

  const digital = collectionsOn && isDigital(method);
  const listed = digital ? accountsForMethod(accounts, method, accountsBranchId) : [];
  const check = validateTransfer({
    method: digital ? method : "cash",
    draft: transfer,
    total: amount,
    listed,
    accountsKnown: accountsState !== "unknown",
    requireAccount: config?.requireAccount ?? true,
  });

  const methods = settleMethodsFor(collectionsOn);
  const methodLabels = dict.app.catalog.payment as Record<string, string>;
  const historyLabels = { methods: methodLabels, initial: dict.app.collections.web.ledger.initialPayment };

  const submit = async () => {
    if (amount <= 0) {
      setError(t.amountRequired);
      return;
    }
    if (check.errors.length > 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/sales/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          customerPhone,
          amount,
          method,
          invoiceIds: [invoice.invoiceId],
          ...collectionOptionsFromDraft(method, transfer, collectionsOn),
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          errorCopy(
            j.error,
            [
              dict.app.customers.settle.errors as Record<string, string>,
              dict.app.collections.errors as Record<string, string>,
            ],
            t.failed,
          ),
        );
        return;
      }
      const json = (await res.json()) as { appliedAmount: number; collectionStatus?: "pending" | null };
      if (json.collectionStatus) void invalidateAfterDecision(qc);
      await onSettled({ collected: json.appliedAmount, collectionStatus: json.collectionStatus ?? null });
    } catch {
      // Network failure: the modal stays open with the same key, so a retry
      // replays instead of recording twice.
      setError(t.failed);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={t.title.replace("{invoice}", invoice.invoiceId)}>
      <div className="space-y-4">
        {/* Invoice snapshot */}
        <div className="grid grid-cols-3 gap-2 p-3 rounded-lg bg-bg-main border border-border text-center">
          <div>
            <p className="text-[10px] text-text-secondary uppercase tracking-wider">{t.total}</p>
            <p className="text-sm font-bold text-text-primary tabular-nums mt-0.5">
              {formatPrice(invoice.total)}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-text-secondary uppercase tracking-wider">{t.paid}</p>
            <p className="text-sm font-bold text-success tabular-nums mt-0.5">
              {formatPrice(invoice.amountPaid)}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-text-secondary uppercase tracking-wider">{t.remaining}</p>
            <p className="text-sm font-bold text-orange-700 tabular-nums mt-0.5">
              {formatPrice(invoice.balance)}
            </p>
          </div>
        </div>

        {/* Amount + method */}
        <div className="space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-text-secondary mb-1">{t.amount}</span>
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
                {t.payRest}
              </button>
            </div>
            {wouldOverpay && (
              <p className="text-[11px] text-danger mt-1">
                {t.overpay.replace("{amount}", formatPrice(invoice.balance))}
              </p>
            )}
          </label>

          <div>
            <span className="block text-xs font-medium text-text-secondary mb-1">{t.method}</span>
            <div className={`grid ${methods.length === 4 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"} gap-2`}>
              {methods.map((m) => (
                <button
                  key={m}
                  type="button"
                  data-testid={`settle-method-${m}`}
                  aria-pressed={method === m}
                  onClick={() => setMethod(m)}
                  className={`py-2 ${collectionsOn ? "min-h-11" : ""} rounded-lg text-sm font-semibold transition-colors border ${
                    method === m
                      ? "bg-accent text-white border-accent"
                      : "bg-white text-text-secondary border-border hover:border-accent/50"
                  }`}
                >
                  {methodLabels[m] ?? m}
                </button>
              ))}
            </div>
            {digital && (
              <TransferPanel
                mode="settle"
                method={method as "instapay" | "wallet"}
                total={amount}
                accounts={listed}
                accountsState={accountsState}
                canManageAccounts={canManage}
                value={transfer}
                onChange={setTransfer}
                errors={check.errors}
                warnings={check.warnings}
              />
            )}
          </div>
        </div>

        {/* Prior payments timeline */}
        <details className="rounded-lg border border-border" open={history.length > 0}>
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-text-secondary flex items-center justify-between">
            <span>
              {t.historyTitle}
              {history.length > 0 && <span className="ms-1 text-accent">({history.length})</span>}
            </span>
            <span className="text-[11px] font-normal text-accent">
              {loadingHistory ? t.historyLoading : t.historyShow}
            </span>
          </summary>
          {history.length === 0 ? (
            <p className="px-3 py-3 text-[11px] text-text-secondary italic">{t.historyEmpty}</p>
          ) : (
            <ul className="max-h-48 overflow-y-auto divide-y divide-border">
              {history.map((p) => {
                const view = paymentEventView(p, historyLabels);
                const tone = HISTORY_TONE[p.method] ?? "bg-accent-light text-accent";
                return (
                  <li
                    key={p.id}
                    className="px-3 py-2 flex items-center justify-between gap-2 text-xs"
                    title={view.struck ? dict.app.collections.web.ledger.voided : undefined}
                  >
                    <div className="min-w-0">
                      <p className="text-text-secondary">{formatDate(new Date(p.recordedAt))}</p>
                      {p.recordedByName && (
                        <p className="text-[10px] text-text-secondary/80 truncate">{p.recordedByName}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${tone}`}>
                        {view.label}
                      </span>
                      {view.pill && <CollectionPill status={view.pill} />}
                      <span
                        className={`font-bold text-success tabular-nums ${view.struck ? "line-through opacity-60" : ""}`}
                      >
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
          <p role="alert" className="text-xs text-danger bg-danger-light px-3 py-2 rounded-lg">
            {error}
          </p>
        )}

        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t.cancel}
          </Button>
          <Button
            className="min-h-11"
            data-testid="settle-submit"
            onClick={submit}
            loading={submitting}
            disabled={amount <= 0 || check.errors.length > 0}
          >
            <Wallet className="w-4 h-4 me-1" />
            {t.submit.replace("{amount}", formatPrice(amount))}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
