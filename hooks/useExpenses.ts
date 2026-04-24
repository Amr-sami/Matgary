"use client";

import { useState, useEffect } from "react";
import { subscribeToExpenses } from "@/lib/firestore";
import type { Expense } from "@/lib/types";

export function useExpenses() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    try {
      const unsubscribe = subscribeToExpenses((data) => {
        setExpenses(data);
        setLoading(false);
      });
      return () => unsubscribe();
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ أثناء تحميل المصروفات");
      setLoading(false);
    }
  }, []);

  return { expenses, loading, error };
}
