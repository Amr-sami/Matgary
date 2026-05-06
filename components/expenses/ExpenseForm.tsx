"use client";

import { useState } from "react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { SupplierPicker } from "../suppliers/SupplierPicker";
import { addExpense } from "@/lib/api/expenses";
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@/lib/types";
import { Wallet, Plus } from "@/lib/icons";

interface ExpenseFormProps {
  onSuccess: () => void;
}

export function ExpenseForm({ onSuccess }: ExpenseFormProps) {
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
        <h3 className="font-bold text-lg">تسجيل مصروف جديد</h3>
      </div>

      <div className="space-y-4">
        <Input
          label="بيان المصروف"
          placeholder="مثلاً: إيجار المحل، فاتورة الكهرباء..."
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />

        <Input
          label="المبلغ (جنيه)"
          type="number"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value === "" ? "" : Number(e.target.value))}
          required
        />

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-secondary pr-1">التصنيف</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {(Object.entries(EXPENSE_CATEGORY_LABELS) as [ExpenseCategory, string][]).map(([val, label]) => (
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
                {label}
              </button>
            ))}
          </div>
        </div>

        {category === "supplier" && (
          <SupplierPicker
            value={supplierId}
            onChange={setSupplierId}
            label="المورد *"
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
                تكرار تلقائي
              </span>
              <p className="text-xs text-text-secondary mt-0.5">
                ستظهر النسخة التالية تلقائياً في موعدها بدون إدخال يدوي.
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
                شهري
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
                أسبوعي
              </button>
            </div>
          )}
        </div>

        <Input
          label="ملاحظة (اختياري)"
          placeholder="..."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <Button type="submit" loading={loading} className="w-full mt-2 gap-2">
          <Plus className="w-4 h-4" />
          تسجيل المصروف
        </Button>
      </div>
    </form>
  );
}
