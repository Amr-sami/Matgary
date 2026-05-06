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

export async function listExpenses(): Promise<Expense[]> {
  const json = await jsonFetch<{ data: ExpenseApiRow[] }>("/api/expenses");
  return json.data.map(reviveExpense);
}

export async function addExpense(input: {
  title: string;
  amount: number;
  category: ExpenseCategory;
  supplierId?: string | null;
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
