"use client";

import { Trash2, RotateCcw, Receipt } from "@/lib/icons";
import { deleteExpense } from "@/lib/api/expenses";
import type { Expense } from "@/lib/types";
import { Badge } from "../ui/Badge";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency, formatDate, formatTime } from "@/lib/i18n/format";

interface ExpenseTableProps {
  expenses: Expense[];
}

export function ExpenseTable({ expenses }: ExpenseTableProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.expenses.table;
  const categoryLabels = dict.app.catalog.expenseCategory;
  const handleDelete = async (id: string) => {
    if (!confirm(t.confirmDelete)) return;
    try {
      await deleteExpense(id);
    } catch (error: any) {
      alert(error.message);
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-border overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] text-start">
          <thead>
            <tr className="text-sm text-text-secondary border-b border-border bg-gray-50/50">
              <th className="py-4 px-6 font-semibold text-start">{t.col.date}</th>
              <th className="py-4 px-6 font-semibold text-start">{t.col.title}</th>
              <th className="py-4 px-6 font-semibold text-start">{t.col.category}</th>
              <th className="py-4 px-6 font-semibold text-start">{t.col.amount}</th>
              <th className="py-4 px-6 font-semibold text-center">{t.col.actions}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {expenses.map((expense) => (
              <tr key={expense.id} className="hover:bg-gray-50/50 transition-colors">
                <td className="py-4 px-6 text-sm">
                  <div className="flex flex-col">
                    <span className="font-medium">{formatDate(expense.date, locale)}</span>
                    <span className="text-[10px] text-text-secondary">
                      {formatTime(expense.date, locale)}
                    </span>
                  </div>
                </td>
                <td className="py-4 px-6">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-bold text-text-primary" dir="auto">{expense.title}</p>
                      {expense.isRecurring && (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-accent-light text-accent font-medium"
                          title={t.recurringTitle}
                        >
                          <RotateCcw className="w-3 h-3" />
                          {expense.recurrencePeriod === "weekly" ? t.weekly : t.monthly}
                        </span>
                      )}
                      {expense.parentExpenseId && (
                        <span
                          className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-text-secondary"
                          title={t.generatedTitle}
                        >
                          {t.generated}
                        </span>
                      )}
                    </div>
                    {expense.note && (
                      <p className="text-xs text-text-secondary mt-0.5" dir="auto">{expense.note}</p>
                    )}
                  </div>
                </td>
                <td className="py-4 px-6">
                  <Badge variant="other">{categoryLabels[expense.category]}</Badge>
                </td>
                <td className="py-4 px-6 font-black text-danger">
                  {formatCurrency(expense.amount, locale)}
                </td>
                <td className="py-4 px-6 text-center">
                  <button
                    onClick={() => handleDelete(expense.id)}
                    className="p-2 text-text-secondary hover:text-danger hover:bg-danger-light rounded-lg transition-all"
                    title={t.deleteTitle}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
            {expenses.length === 0 && (
              <tr>
                <td colSpan={5} className="py-12 text-center text-text-secondary">
                  <Receipt className="w-12 h-12 mx-auto mb-3 opacity-20" />
                  <p>{t.empty}</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
