"use client";

import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { addExpense } from "@/lib/api/expenses";
import type { SupplierDescriptor } from "@/lib/types";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

interface SupplierPaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  supplier: SupplierDescriptor;
  onSaved: () => void | Promise<void>;
  onError: (message: string) => void;
}

/**
 * Settle a supplier from their own detail page. A supplier payment IS an
 * expense (`category: "supplier"` + `supplierId`) — the same POST /api/expenses
 * the Expenses page's form sends, which debits the supplier balance server-side.
 * This modal pins the category and the supplier so the user only types an
 * amount, instead of being sent to /expenses to re-pick the supplier.
 */
export function SupplierPaymentModal({
  isOpen,
  onClose,
  supplier,
  onSaved,
  onError,
}: SupplierPaymentModalProps) {
  const t = useDictionary().app.suppliers.detail.paymentModal;
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t.title}>
      {/* Modal renders nothing while closed, so the form mounts fresh on
          every open — a second payment never inherits the first one's fields. */}
      <PaymentForm
        supplier={supplier}
        onClose={onClose}
        onSaved={onSaved}
        onError={onError}
      />
    </Modal>
  );
}

function PaymentForm({
  supplier,
  onClose,
  onSaved,
  onError,
}: Omit<SupplierPaymentModalProps, "isOpen">) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.suppliers.detail.paymentModal;
  const form = dict.app.expenses.form;
  const [title, setTitle] = useState(() =>
    t.defaultTitle.replace("{name}", supplier.name),
  );
  const [amount, setAmount] = useState<number | "">(() =>
    supplier.balance > 0 ? supplier.balance : "",
  );
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || amount === "" || Number(amount) <= 0) return;
    setLoading(true);
    try {
      await addExpense({
        title: title.trim(),
        amount: Number(amount),
        category: "supplier",
        supplierId: supplier.id,
        note: note.trim() || undefined,
      });
      await onSaved();
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : dict.app.common.error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="p-4 bg-gray-50 rounded-lg">
        <p className="font-medium" dir="auto">
          {supplier.name}
        </p>
        <p className="text-sm text-text-secondary">
          {t.owed.replace("{amount}", formatCurrency(supplier.balance, locale))}
        </p>
      </div>

      <Input
        label={form.amountLabel}
        type="number"
        inputMode="decimal"
        min={0.01}
        step="0.01"
        placeholder={form.amountPlaceholder}
        value={amount}
        onChange={(e) =>
          setAmount(e.target.value === "" ? "" : Number(e.target.value))
        }
        required
        autoFocus
      />

      <Input
        label={form.titleLabel}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />

      <Input
        label={form.noteLabel}
        placeholder={form.notePlaceholder}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      <p className="text-xs text-text-secondary">{t.hint}</p>

      <div className="flex gap-3 pt-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          className="flex-1"
        >
          {dict.app.common.cancel}
        </Button>
        <Button
          type="submit"
          loading={loading}
          disabled={!title.trim() || amount === "" || Number(amount) <= 0}
          className="flex-1"
        >
          {t.submit}
        </Button>
      </div>
    </form>
  );
}
