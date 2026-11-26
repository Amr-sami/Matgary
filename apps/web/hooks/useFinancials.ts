"use client";

// Thin client-side wrappers around the /api/financials/* endpoints. Both
// hooks share the same SWR-shaped contract: `{ data, loading, error, refresh }`.
// The server is the single source of truth — no P&L arithmetic in React.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FinancialOverview, PnL } from "@/lib/finance/types";
import type { DatePresetKey } from "@/lib/finance/dates";

export type FinancialsPreset = DatePresetKey;
export type { DatePresetKey };

export interface FinancialsRange {
  preset: FinancialsPreset;
  from?: string;
  to?: string;
}

function buildQuery(range: FinancialsRange): string {
  const q = new URLSearchParams();
  q.set("preset", range.preset);
  if (range.preset === "custom") {
    if (range.from) q.set("from", range.from);
    if (range.to) q.set("to", range.to);
  }
  return q.toString();
}

// A tiny FSM so transient loading never nukes previously-rendered data.
// (The existing Insights hook uses the same shape.)
function usePolledFinance<T>(path: string, range: FinancialsRange) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // `forbidden` surfaces as a specific UI state (not a generic error toast).
  const [forbidden, setForbidden] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    setError(null);
    try {
      const res = await fetch(`${path}?${buildQuery(range)}`, {
        signal: ac.signal,
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        // Don't clear existing data — the UI falls through to the
        // forbidden message cleanly.
        return;
      }
      if (!res.ok) {
        throw new Error(`failed (${res.status})`);
      }
      const json = (await res.json()) as { data: T };
      setData(json.data);
      setForbidden(false);
    } catch (err) {
      if ((err as { name?: string } | undefined)?.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "unknown");
    } finally {
      setLoading(false);
    }
  }, [path, range.preset, range.from, range.to]);

  useEffect(() => {
    setLoading(true);
    void fetchOnce();
    return () => inflight.current?.abort();
  }, [fetchOnce]);

  return { data, loading, error, forbidden, refresh: fetchOnce };
}

export function useFinancialOverview(range: FinancialsRange) {
  return usePolledFinance<FinancialOverview>("/api/financials/overview", range);
}

// The /pnl endpoint also returns `seesProfit` and `movements` siblings —
// expose them alongside `data`.
interface PnlPayload {
  data: PnL & {
    grossProfit: PnL["grossProfit"] | null;
    operatingProfit: PnL["operatingProfit"] | null;
    netProfit: PnL["netProfit"] | null;
    grossMargin: PnL["grossMargin"] | null;
    netMargin: PnL["netMargin"] | null;
  };
  seesProfit: boolean;
  movements: { movementId: string; kind: string; amount: number; direction: "in" | "out" }[];
}

// ─── Expenses CRUD ──────────────────────────────────────────────────────────

export interface FinanceExpenseListItem {
  id: string;
  title: string;
  amount: number;
  date: string;
  categoryId: string | null;
  categorySlug: string | null;
  categoryNameEn: string | null;
  categoryNameAr: string | null;
  categoryGroupSlug: string | null;
  paymentMethod: string | null;
  referenceNumber: string | null;
  note: string | null;
  supplierId: string | null;
  status: "posted" | "voided";
  voidedAt: string | null;
  voidReason: string | null;
  createdByUserId: string | null;
  isRecurringTemplate: boolean;
  parentExpenseId: string | null;
}

export interface FinanceExpensesListFilters {
  from?: string;
  to?: string;
  categoryId?: string;
  paymentMethod?: string;
  status?: "posted" | "voided" | "any";
  minAmount?: number;
  maxAmount?: number;
  search?: string;
  cursor?: string | null;
  limit?: number;
}

function buildExpenseQuery(f: FinanceExpensesListFilters): string {
  const q = new URLSearchParams();
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (f.categoryId) q.set("categoryId", f.categoryId);
  if (f.paymentMethod) q.set("paymentMethod", f.paymentMethod);
  if (f.status) q.set("status", f.status);
  if (f.minAmount !== undefined) q.set("minAmount", String(f.minAmount));
  if (f.maxAmount !== undefined) q.set("maxAmount", String(f.maxAmount));
  if (f.search) q.set("search", f.search);
  if (f.cursor) q.set("cursor", f.cursor);
  if (f.limit) q.set("limit", String(f.limit));
  return q.toString();
}

export function useFinanceExpenses(filters: FinanceExpensesListFilters) {
  const [data, setData] = useState<{
    data: FinanceExpenseListItem[];
    nextCursor: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  const query = buildExpenseQuery(filters);

  const refresh = useCallback(async () => {
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    setError(null);
    try {
      const res = await fetch(`/api/financials/expenses?${query}`, {
        signal: ac.signal,
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error(`failed (${res.status})`);
      const json = (await res.json()) as {
        data: FinanceExpenseListItem[];
        nextCursor: string | null;
      };
      setData(json);
      setForbidden(false);
    } catch (err) {
      if ((err as { name?: string } | undefined)?.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "unknown");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    return () => inflight.current?.abort();
  }, [refresh]);

  return { data, loading, error, forbidden, refresh };
}

// ─── Category tree + custom CRUD ───────────────────────────────────────────

export interface FinanceCategoryNode {
  id: string;
  parentId: string | null;
  slug: string;
  nameEn: string;
  nameAr: string;
  kind: "opex" | "other_income" | "other_expense";
  isSystem: boolean;
  sortOrder: number;
  archivedAt: string | null;
  children: FinanceCategoryNode[];
}

export function useFinanceCategories() {
  const [tree, setTree] = useState<FinanceCategoryNode[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/financials/categories", {
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error(`failed (${res.status})`);
      const json = (await res.json()) as { data: FinanceCategoryNode[] };
      setTree(json.data);
      setForbidden(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { tree, loading, error, forbidden, refresh };
}

// ─── Profitability + Trends ────────────────────────────────────────────────

export interface ProductProfitRow {
  productId: string;
  productName: string;
  brand: string | null;
  quantitySold: number;
  revenue: number;
  cogs: number | null;
  grossProfit: number | null;
  margin: number | null;
}

export interface CategoryProfitRow {
  categoryId: string;
  categoryLabel: string | null;
  quantitySold: number;
  revenue: number;
  cogs: number | null;
  grossProfit: number | null;
  margin: number | null;
}

export type ProfitabilitySort = "revenue" | "grossProfit" | "margin" | "quantity";

export function useProductProfitability(opts: {
  preset: DatePresetKey;
  from?: string;
  to?: string;
  sort?: ProfitabilitySort;
  search?: string;
  limit?: number;
}) {
  const [data, setData] = useState<{ rows: ProductProfitRow[]; total: number; seesProfit: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  const q = useMemo(() => {
    const p = new URLSearchParams();
    p.set("preset", opts.preset);
    if (opts.from) p.set("from", opts.from);
    if (opts.to) p.set("to", opts.to);
    if (opts.sort) p.set("sort", opts.sort);
    if (opts.search) p.set("search", opts.search);
    if (opts.limit) p.set("limit", String(opts.limit));
    return p.toString();
  }, [opts.preset, opts.from, opts.to, opts.sort, opts.search, opts.limit]);

  const refresh = useCallback(async () => {
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    setError(null);
    try {
      const res = await fetch(`/api/financials/profitability/products?${q}`, {
        signal: ac.signal,
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error(`failed (${res.status})`);
      const json = (await res.json()) as {
        data: ProductProfitRow[];
        total: number;
        seesProfit: boolean;
      };
      setData({ rows: json.data, total: json.total, seesProfit: json.seesProfit });
      setForbidden(false);
    } catch (err) {
      if ((err as { name?: string } | undefined)?.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "unknown");
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    return () => inflight.current?.abort();
  }, [refresh]);

  return { data, loading, error, forbidden, refresh };
}

export function useCategoryProfitability(opts: {
  preset: DatePresetKey;
  from?: string;
  to?: string;
  sort?: ProfitabilitySort;
}) {
  const [data, setData] = useState<{ rows: CategoryProfitRow[]; seesProfit: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const q = useMemo(() => {
    const p = new URLSearchParams();
    p.set("preset", opts.preset);
    if (opts.from) p.set("from", opts.from);
    if (opts.to) p.set("to", opts.to);
    if (opts.sort) p.set("sort", opts.sort);
    return p.toString();
  }, [opts.preset, opts.from, opts.to, opts.sort]);

  useEffect(() => {
    setLoading(true);
    let aborted = false;
    (async () => {
      try {
        const res = await fetch(`/api/financials/profitability/categories?${q}`, {
          cache: "no-store",
        });
        if (res.status === 401 || res.status === 403) {
          if (!aborted) setForbidden(true);
          return;
        }
        if (!res.ok) throw new Error(`failed (${res.status})`);
        const json = (await res.json()) as {
          data: CategoryProfitRow[];
          seesProfit: boolean;
        };
        if (!aborted)
          setData({ rows: json.data, seesProfit: json.seesProfit });
      } catch (err) {
        if (!aborted)
          setError(err instanceof Error ? err.message : "unknown");
      } finally {
        if (!aborted) setLoading(false);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [q]);

  return { data, loading, error, forbidden };
}

export interface TrendPoint {
  date: string;
  revenue: number;
  discounts: number;
  returnsRevenue: number;
  netSales: number;
  cogs: number | null;
  grossProfit: number | null;
  operatingExpenses: number;
  operatingProfit: number | null;
  netProfit: number | null;
}

export function useFinancialTrends(opts: {
  preset: DatePresetKey;
  from?: string;
  to?: string;
  bucket?: "day" | "week" | "month";
}) {
  const [data, setData] = useState<{
    bucket: "day" | "week" | "month";
    data: TrendPoint[];
    seesProfit: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const q = useMemo(() => {
    const p = new URLSearchParams();
    p.set("preset", opts.preset);
    if (opts.from) p.set("from", opts.from);
    if (opts.to) p.set("to", opts.to);
    if (opts.bucket) p.set("bucket", opts.bucket);
    return p.toString();
  }, [opts.preset, opts.from, opts.to, opts.bucket]);

  useEffect(() => {
    setLoading(true);
    let aborted = false;
    (async () => {
      try {
        const res = await fetch(`/api/financials/trends?${q}`, {
          cache: "no-store",
        });
        if (res.status === 401 || res.status === 403) {
          if (!aborted) setForbidden(true);
          return;
        }
        if (!res.ok) throw new Error(`failed (${res.status})`);
        const json = (await res.json()) as {
          bucket: "day" | "week" | "month";
          data: TrendPoint[];
          seesProfit: boolean;
        };
        if (!aborted) setData(json);
      } finally {
        if (!aborted) setLoading(false);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [q]);

  return { data, loading, forbidden };
}

// ─── Money Movements ───────────────────────────────────────────────────────

export const MONEY_MOVEMENT_KINDS = [
  "owner_deposit",
  "owner_withdrawal",
  "cash_transfer",
  "loan_received",
  "loan_principal_repayment",
  "supplier_payment_direct",
  "customer_deposit",
  "other",
] as const;
export type MoneyMovementKind = (typeof MONEY_MOVEMENT_KINDS)[number];

export interface MoneyMovementRow {
  id: string;
  kind: MoneyMovementKind;
  direction: "in" | "out";
  amount: number;
  occurredAt: string;
  description: string | null;
  paymentMethod: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  createdByUserId: string | null;
  voidedAt: string | null;
  voidedByUserId: string | null;
  voidReason: string | null;
}

export interface MoneyMovementFilters {
  from?: string;
  to?: string;
  kind?: MoneyMovementKind;
  status?: "active" | "voided" | "any";
}

export function useMoneyMovements(filters: MoneyMovementFilters) {
  const [data, setData] = useState<{
    data: MoneyMovementRow[];
    nextCursor: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (filters.from) q.set("from", filters.from);
    if (filters.to) q.set("to", filters.to);
    if (filters.kind) q.set("kind", filters.kind);
    if (filters.status) q.set("status", filters.status);
    return q.toString();
  }, [filters.from, filters.to, filters.kind, filters.status]);

  const refresh = useCallback(async () => {
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    setError(null);
    try {
      const res = await fetch(`/api/financials/money-movements?${query}`, {
        signal: ac.signal,
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error(`failed (${res.status})`);
      const json = (await res.json()) as {
        data: MoneyMovementRow[];
        nextCursor: string | null;
      };
      setData(json);
      setForbidden(false);
    } catch (err) {
      if ((err as { name?: string } | undefined)?.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "unknown");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    return () => inflight.current?.abort();
  }, [refresh]);

  return { data, loading, error, forbidden, refresh };
}

export function useFinancialPnL(range: FinancialsRange) {
  const [data, setData] = useState<PnlPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    setError(null);
    try {
      const res = await fetch(`/api/financials/pnl?${buildQuery(range)}`, {
        signal: ac.signal,
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error(`failed (${res.status})`);
      const json = (await res.json()) as PnlPayload;
      setData(json);
      setForbidden(false);
    } catch (err) {
      if ((err as { name?: string } | undefined)?.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "unknown");
    } finally {
      setLoading(false);
    }
  }, [range.preset, range.from, range.to]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    return () => inflight.current?.abort();
  }, [refresh]);

  return { data, loading, error, forbidden, refresh };
}
