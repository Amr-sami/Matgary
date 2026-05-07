"use client";

import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { ExpenseForm } from "@/components/expenses/ExpenseForm";
import { ExpenseTable } from "@/components/expenses/ExpenseTable";
import { useExpenses } from "@/hooks/useExpenses";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { Toast } from "@/components/ui/Toast";
import { formatPrice } from "@/lib/utils";
import { Wallet, TrendingDown } from "@/lib/icons";

export default function ExpensesPage() {
  const { expenses, loading } = useExpenses();
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);

  if (loading) {
    return (
      <AppShell title="المصاريف">
        <PageSkeleton rows={6} cards={false} />
      </AppShell>
    );
  }

  return (
    <AppShell title="إدارة المصاريف">
      <div className="space-y-6">
        {/* Summary Card */}
        <div className="bg-white rounded-xl p-6 shadow-sm border border-border relative overflow-hidden group">
          <div className="relative z-10 flex items-center justify-between">
            <div>
              <p className="text-sm text-text-secondary">إجمالي المصاريف المسجلة</p>
              <p className="text-3xl font-black mt-1 text-danger">{formatPrice(totalExpenses)}</p>
            </div>
            <TrendingDown className="w-8 h-8 text-danger" />
          </div>
          <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
            <Wallet className="w-24 h-24" />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* New Expense Form */}
          <div className="lg:col-span-1">
            <div className="sticky top-6">
              <ExpenseForm onSuccess={() => setToast({ type: "success", message: "تم تسجيل المصروف بنجاح" })} />
            </div>
          </div>

          {/* Expenses List */}
          <div className="lg:col-span-2 space-y-4">
            <h3 className="font-bold text-lg px-1">سجل المصاريف</h3>
            <ExpenseTable expenses={expenses} />
          </div>
        </div>
      </div>

      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </AppShell>
  );
}
