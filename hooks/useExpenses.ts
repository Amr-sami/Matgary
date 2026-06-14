"use client";

import { useCallback, useEffect, useState } from "react";
import { listExpenses } from "@/lib/api/expenses";
import type { Expense } from "@/lib/types";

export interface UseExpensesOptions {
  all?: boolean;
  days?: number;
}

export function useExpenses(opts: UseExpensesOptions = {}) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { all, days } = opts;

  const refresh = useCallback(async () => {
    try {
      const data = await listExpenses({ all, days });
      setExpenses(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ أثناء تحميل المصروفات");
    } finally {
      setLoading(false);
    }
  }, [all, days]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { expenses, loading, error, refresh };
}
