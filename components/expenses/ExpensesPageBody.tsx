"use client";

// Client island for /expenses. Holds the data fetch (useExpenses),
// the toast state, the live summary card (which depends on the
// fetched list), and the form + table. The page shell stays on the
// server.

import { useState } from "react";
import { ExpenseForm } from "./ExpenseForm";
import { ExpenseTable } from "./ExpenseTable";
import { useExpenses } from "@/hooks/useExpenses";
import { PageSkeleton } from "../ui/PageSkeleton";
import { Toast } from "../ui/Toast";
import { Wallet, TrendingDown } from "@/lib/icons";
import { formatCurrency } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/config";

interface ExpensesPageBodyProps {
  locale: Locale;
  strings: {
    summaryLabel: string;
    listHeading: string;
    addedToast: string;
  };
}

export function ExpensesPageBody({ locale, strings }: ExpensesPageBodyProps) {
  const { expenses, loading, refresh } = useExpenses();
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);

  if (loading) {
    return <PageSkeleton rows={6} cards={false} />;
  }

  return (
    <>
      <div className="bg-white rounded-xl p-6 shadow-sm border border-border relative overflow-hidden group">
        <div className="relative z-10 flex items-center justify-between">
          <div>
            <p className="text-sm text-text-secondary">{strings.summaryLabel}</p>
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
        <div className="lg:col-span-1">
          <div className="sticky top-6">
            <ExpenseForm
              onSuccess={() => {
                setToast({ type: "success", message: strings.addedToast });
                void refresh();
              }}
            />
          </div>
        </div>

        <div className="lg:col-span-2 space-y-4">
          <h3 className="font-bold text-lg px-1">{strings.listHeading}</h3>
          <ExpenseTable expenses={expenses} />
        </div>
      </div>

      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          onClose={() => setToast(null)}
        />
      )}
    </>
  );
}
