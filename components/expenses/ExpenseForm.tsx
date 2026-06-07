"use client";

import { useState } from "react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { SupplierPicker } from "../suppliers/SupplierPicker";
import { addExpense } from "@/lib/api/expenses";
import type { ExpenseCategory } from "@/lib/types";
import { Wallet, Plus } from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface ExpenseFormProps {
  onSuccess: () => void;
}

const CATEGORY_ORDER: ExpenseCategory[] = [
  "rent",
  "salaries",
  "electricity",
  "water",
  "internet",
  "supplier",
  "other",
];

export function ExpenseForm({ onSuccess }: ExpenseFormProps) {
  const dict = useDictionary();
  const t = dict.app.expenses.form;
  const categoryLabels = dict.app.catalog.expenseCategory;
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState<number | "">("");
  const [category, setCategory] = useState<ExpenseCategory>("other");
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrencePeriod, setRecurrencePeriod] = useState<"monthly" | "weekly">("monthly");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !amount) return;

    setLoading(true);
    try {
      await addExpense({
        title,
        amount: Number(amount),
        category,
        supplierId: supplierId,
        isRecurring,
        recurrencePeriod: isRecurring ? recurrencePeriod : null,
        note: note || undefined,
      });
      setTitle("");
      setAmount("");
      setCategory("other");
      setSupplierId(null);
      setIsRecurring(false);
      setRecurrencePeriod("monthly");
      setNote("");
      onSuccess();
    } catch (error: any) {
      alert(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-xl p-5 shadow-sm border border-border">
      <div className="flex items-center gap-2 mb-6 text-accent">
        <Wallet className="w-5 h-5" />
        <h3 className="font-bold text-lg">{t.heading}</h3>
      </div>

      <div className="space-y-4">
        <Input
          label={t.titleLabel}
          placeholder={t.titlePlaceholder}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />

        <Input
          label={t.amountLabel}
          type="number"
          placeholder={t.amountPlaceholder}
          value={amount}
          onChange={(e) => setAmount(e.target.value === "" ? "" : Number(e.target.value))}
          required
        />

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-secondary pe-1">{t.categoryLabel}</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {CATEGORY_ORDER.map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => setCategory(val)}
                className={`flex items-center justify-center py-2.5 px-3 rounded-lg text-sm font-medium transition-all border ${
                  category === val
                    ? "bg-accent border-accent text-white shadow-md shadow-accent/20"
                    : "bg-white border-border text-text-secondary hover:bg-gray-50"
                }`}
              >
                {categoryLabels[val]}
              </button>
            ))}
          </div>
        </div>

        {category === "supplier" && (
          <SupplierPicker
            value={supplierId}
            onChange={setSupplierId}
            label={t.supplierLabel}
          />
        )}

        {/* Recurring toggle */}
        <div className="rounded-lg border border-border bg-bg-main/40 p-3 space-y-2">
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 accent-accent w-4 h-4"
              checked={isRecurring}
              onChange={(e) => setIsRecurring(e.target.checked)}
            />
            <div>
              <span className="font-medium text-text-primary">
                {t.recurring.title}
              </span>
              <p className="text-xs text-text-secondary mt-0.5">
                {t.recurring.hint}
              </p>
            </div>
          </label>
          {isRecurring && (
            <div className="flex gap-2 ps-6">
              <button
                type="button"
                onClick={() => setRecurrencePeriod("monthly")}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                  recurrencePeriod === "monthly"
                    ? "bg-accent text-white border-accent"
                    : "bg-white border-border text-text-secondary hover:border-accent"
                }`}
              >
                {t.recurring.monthly}
              </button>
              <button
                type="button"
                onClick={() => setRecurrencePeriod("weekly")}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                  recurrencePeriod === "weekly"
                    ? "bg-accent text-white border-accent"
                    : "bg-white border-border text-text-secondary hover:border-accent"
                }`}
              >
                {t.recurring.weekly}
              </button>
            </div>
          )}
        </div>

        <Input
          label={t.noteLabel}
          placeholder={t.notePlaceholder}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <Button type="submit" loading={loading} className="w-full mt-2 gap-2">
          <Plus className="w-4 h-4" />
          {t.submit}
        </Button>
      </div>
    </form>
  );
}
