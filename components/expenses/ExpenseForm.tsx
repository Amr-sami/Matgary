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
        note: note || undefined,
      });
      setTitle("");
      setAmount("");
      setCategory("other");
      setSupplierId(null);
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
