import type { Expense, ExpenseCategory } from "@/lib/types";

interface ExpenseApiRow extends Omit<Expense, "date"> {
  date: string;
}

function reviveExpense(e: ExpenseApiRow): Expense {
  return { ...e, date: new Date(e.date) };
}

async function jsonFetch<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? (null as T) : res.json();
}

export async function listExpenses(opts?: {
  all?: boolean;
  days?: number;
}): Promise<Expense[]> {
  const qs = new URLSearchParams();
  if (opts?.all) qs.set("all", "1");
  else if (opts?.days) qs.set("days", String(opts.days));
  const url = qs.toString() ? `/api/expenses?${qs}` : "/api/expenses";
  const json = await jsonFetch<{ data: ExpenseApiRow[] }>(url);
  return json.data.map(reviveExpense);
}

export async function addExpense(input: {
  title: string;
  amount: number;
  category: ExpenseCategory;
  supplierId?: string | null;
  isRecurring?: boolean;
  recurrencePeriod?: "monthly" | "weekly" | null;
  date?: Date;
  note?: string;
}): Promise<string> {
  const res = await jsonFetch<{ id: string }>("/api/expenses", {
    method: "POST",
    body: JSON.stringify({
      ...input,
      date: input.date?.toISOString(),
    }),
  });
  return res.id;
}

export async function deleteExpense(expenseId: string): Promise<void> {
  await jsonFetch(`/api/expenses/${expenseId}`, { method: "DELETE" });
}
