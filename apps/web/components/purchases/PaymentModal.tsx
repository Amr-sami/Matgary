"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

type Method = "cash" | "bank" | "vfcash" | "instapay" | "other";

interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  purchaseOrderId: string;
  supplierName: string;
  total: number;
  paidAmount: number;
  onSaved: () => void;
  onError: (msg: string) => void;
}

const METHOD_ORDER: Method[] = ["cash", "bank", "vfcash", "instapay", "other"];

export function PaymentModal({
  isOpen,
  onClose,
  purchaseOrderId,
  supplierName,
  total,
  paidAmount,
  onSaved,
  onError,
}: PaymentModalProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.purchases.paymentModal;
  const methodLabels = dict.app.purchases.paymentMethod;
  const remaining = Math.max(0, Math.round((total - paidAmount) * 100) / 100);
  const [amount, setAmount] = useState<string>("");
  const [method, setMethod] = useState<Method>("cash");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setAmount(remaining > 0 ? String(remaining) : "");
      setMethod("cash");
      setNotes("");
    }
  }, [isOpen, remaining]);

  const numericAmount = Number(amount);
  const isValid =
    Number.isFinite(numericAmount) &&
    numericAmount > 0 &&
    numericAmount <= remaining + 0.001;

  const submit = async () => {
    if (!isValid) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/purchase-orders/${purchaseOrderId}/payments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: numericAmount,
            method,
            notes: notes.trim() || null,
          }),
        },
      );
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        onError(json.error || t.error);
        return;
      }
      onSaved();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  // Use "bankTransfer" copy for the bank button — it's the more accurate
  // wording inside the payment dialog (the row badge stays "bank" / "Bank").
  const methodButtonLabel = (m: Method) =>
    m === "bank" ? methodLabels.bankTransfer : methodLabels[m];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t.title.replace("{name}", supplierName)}>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label={t.totalLabel} value={formatCurrency(total, locale)} />
          <Stat label={t.paidLabel} value={formatCurrency(paidAmount, locale)} tone="success" />
          <Stat label={t.remainingLabel} value={formatCurrency(remaining, locale)} tone="danger" />
        </div>

        <div>
          <label className="block text-sm text-text-secondary mb-1">{t.amountLabel}</label>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            max={remaining}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            dir="ltr"
            className="w-full px-3 py-2 rounded-lg border border-border focus:outline-none focus:border-accent"
            placeholder={t.amountPlaceholder.replace(
              "{amount}",
              formatCurrency(remaining, locale),
            )}
            autoFocus
          />
          <div className="flex flex-wrap gap-2 mt-2">
            <QuickAmount label={t.quickAmounts.quarter} value={remaining / 4} setter={setAmount} />
            <QuickAmount label={t.quickAmounts.half} value={remaining / 2} setter={setAmount} />
            <QuickAmount label={t.quickAmounts.all} value={remaining} setter={setAmount} />
          </div>
        </div>

        <div>
          <label className="block text-sm text-text-secondary mb-1">{t.methodLabel}</label>
          <div className="flex flex-wrap gap-2">
            {METHOD_ORDER.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  method === m
                    ? "bg-accent text-white"
                    : "bg-white border border-border text-text-secondary hover:border-accent"
                }`}
              >
                {methodButtonLabel(m)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm text-text-secondary mb-1">{t.notesLabel}</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            dir="auto"
            rows={2}
            maxLength={500}
            className="w-full px-3 py-2 rounded-lg border border-border focus:outline-none focus:border-accent resize-none"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t.cancel}
          </Button>
          <Button onClick={submit} disabled={!isValid || submitting}>
            {submitting ? t.saving : t.save}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "danger";
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "danger"
        ? "text-danger"
        : "text-text-primary";
  return (
    <div className="rounded-lg border border-border bg-white p-2">
      <p className="text-[10px] text-text-secondary">{label}</p>
      <p className={`text-sm font-bold ${color}`}>{value}</p>
    </div>
  );
}

function QuickAmount({
  label,
  value,
  setter,
}: {
  label: string;
  value: number;
  setter: (v: string) => void;
}) {
  if (value <= 0) return null;
  return (
    <button
      type="button"
      onClick={() => setter(String(Math.round(value * 100) / 100))}
      className="px-2 py-1 rounded-md text-xs bg-gray-100 hover:bg-gray-200 text-text-secondary"
    >
      {label}
    </button>
  );
}
