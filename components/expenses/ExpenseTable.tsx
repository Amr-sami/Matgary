"use client";

import { Trash2, Calendar, Receipt } from "@/lib/icons";
import { deleteExpense } from "@/lib/api/expenses";
import type { Expense } from "@/lib/types";
import { formatPrice, formatDate } from "@/lib/utils";
import { EXPENSE_CATEGORY_LABELS } from "@/lib/types";
import { Badge } from "../ui/Badge";

interface ExpenseTableProps {
  expenses: Expense[];
}

export function ExpenseTable({ expenses }: ExpenseTableProps) {
  const handleDelete = async (id: string) => {
    if (!confirm("هل أنت متأكد من حذف هذا المصروف؟")) return;
    try {
      await deleteExpense(id);
    } catch (error: any) {
      alert(error.message);
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-border overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] text-right" dir="rtl">
          <thead>
            <tr className="text-sm text-text-secondary border-b border-border bg-gray-50/50">
              <th className="py-4 px-6 font-semibold">التاريخ</th>
              <th className="py-4 px-6 font-semibold">البيان</th>
              <th className="py-4 px-6 font-semibold">التصنيف</th>
              <th className="py-4 px-6 font-semibold">القيمة</th>
              <th className="py-4 px-6 font-semibold text-center">إجراء</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {expenses.map((expense) => (
              <tr key={expense.id} className="hover:bg-gray-50/50 transition-colors">
                <td className="py-4 px-6 text-sm">
                  <div className="flex flex-col">
                    <span className="font-medium">{formatDate(expense.date)}</span>
                    <span className="text-[10px] text-text-secondary">
                      {expense.date.toLocaleTimeString("ar-EG", { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </td>
                <td className="py-4 px-6">
                  <div>
                    <p className="font-bold text-text-primary">{expense.title}</p>
                    {expense.note && (
                      <p className="text-xs text-text-secondary mt-0.5">{expense.note}</p>
                    )}
                  </div>
                </td>
                <td className="py-4 px-6">
                  <Badge variant="other">{EXPENSE_CATEGORY_LABELS[expense.category]}</Badge>
                </td>
                <td className="py-4 px-6 font-black text-danger">
                  {formatPrice(expense.amount)}
                </td>
                <td className="py-4 px-6 text-center">
                  <button
                    onClick={() => handleDelete(expense.id)}
                    className="p-2 text-text-secondary hover:text-danger hover:bg-danger-light rounded-lg transition-all"
                    title="حذف"
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
                  <p>لا توجد مصاريف مسجلة حالياً</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
