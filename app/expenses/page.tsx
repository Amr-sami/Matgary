"use client";

import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { ExpenseForm } from "@/components/expenses/ExpenseForm";
import { ExpenseTable } from "@/components/expenses/ExpenseTable";
import { useExpenses } from "@/hooks/useExpenses";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { Toast } from "@/components/ui/Toast";
import { Wallet, TrendingDown } from "@/lib/icons";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

export default function ExpensesPage() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.expenses;
  const { expenses, loading, refresh } = useExpenses();
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);

  if (loading) {
    return (
      <AppShell title={t.title}>
        <PageSkeleton rows={6} cards={false} />
      </AppShell>
    );
  }

  return (
    <AppShell title={t.manageTitle}>
      <div className="space-y-6">
        {/* Summary Card */}
        <div className="bg-white rounded-xl p-6 shadow-sm border border-border relative overflow-hidden group">
          <div className="relative z-10 flex items-center justify-between">
            <div>
              <p className="text-sm text-text-secondary">{t.summary.label}</p>
              <p className="text-3xl font-black mt-1 text-danger">
                {formatCurrency(totalExpenses, locale)}
              </p>
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
              <ExpenseForm
                onSuccess={() => {
                  setToast({ type: "success", message: t.toast.added });
                  void refresh();
                }}
              />
            </div>
          </div>

          {/* Expenses List */}
          <div className="lg:col-span-2 space-y-4">
            <h3 className="font-bold text-lg px-1">{t.listHeading}</h3>
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
