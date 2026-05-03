"use client";

import { useCallback, useEffect, useState } from "react";
import { listExpenses } from "@/lib/api/expenses";
import type { Expense } from "@/lib/types";

export function useExpenses() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listExpenses();
      setExpenses(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ أثناء تحميل المصروفات");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { expenses, loading, error, refresh };
}
