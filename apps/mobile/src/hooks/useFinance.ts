// Mobile finance hooks. Thin wrappers around /api/financials/* so every
// screen reads from the SAME backend the web does — the P&L engine stays the
// single source of truth. Mobile does no accounting arithmetic in JS.
//
// Uses TanStack Query (the mobile idiom) instead of the web's hand-rolled
// FSM; same query keys across screens mean a mutation only needs
// invalidateQueries once.

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "@/api/client";

// ─────────────────────────────────────────────────────────────────────────────
// Date range (mirrors apps/web/lib/finance/dates.ts preset keys)

export type FinancialsPreset =
  | "today"
  | "yesterday"
  | "this_week"
  | "this_month"
  | "last_month"
  | "last_7_days"
  | "last_30_days"
  | "this_year"
  | "custom";

export interface FinancialsRange {
  preset: FinancialsPreset;
  /** ISO day ("YYYY-MM-DD") — only sent when preset === "custom". */
  from?: string;
  to?: string;
}

function buildRangeQuery(range: FinancialsRange): string {
  const q = new URLSearchParams();
  q.set("preset", range.preset);
  if (range.preset === "custom") {
    if (range.from) q.set("from", range.from);
    if (range.to) q.set("to", range.to);
  }
  return q.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Overview

export interface FinancialOverview {
  grossSales: number;
  discounts: number;
  returnsRevenue: number;
  netSales: number;
  cogs: number;
  grossProfit: number;
  grossMargin: number;
  operatingExpenses: number;
  operatingProfit: number;
  otherIncome: number;
  otherExpense: number;
  netProfit: number;
  netMargin: number;
  salesCount: number;
  returnsCount: number;
  moneyIn: number;
  moneyOut: number;
}

export function useFinancialOverview(range: FinancialsRange) {
  return useQuery({
    queryKey: ["fin", "overview", range],
    queryFn: () =>
      api.request<{ data: FinancialOverview }>(
        `/api/financials/overview?${buildRangeQuery(range)}`,
      ),
    select: (r) => r.data,
    staleTime: 60_000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// P&L

export interface PnLOpexGroup {
  groupSlug: string;
  groupNameEn: string;
  groupNameAr: string;
  total: number;
  lines: { slug: string; nameEn: string; nameAr: string; total: number }[];
}

export interface PnL {
  grossSales: number;
  discounts: number;
  returnsRevenue: number;
  netSales: number;
  cogs: number;
  grossProfit: number | null;
  operatingExpensesByGroup: PnLOpexGroup[];
  operatingExpenses: number;
  operatingProfit: number | null;
  otherIncome: number;
  otherExpense: number;
  netProfit: number | null;
  netMargin: number | null;
  grossMargin: number | null;
}

export function useFinancialPnL(range: FinancialsRange) {
  return useQuery({
    queryKey: ["fin", "pnl", range],
    queryFn: () =>
      api.request<{ data: PnL; seesProfit: boolean }>(
        `/api/financials/pnl?${buildRangeQuery(range)}`,
      ),
    staleTime: 60_000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Trends (chart data)

export interface TrendPoint {
  bucketStart: string;
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

export function useFinancialTrends(range: FinancialsRange) {
  return useQuery({
    queryKey: ["fin", "trends", range],
    queryFn: () =>
      api.request<{
        data: TrendPoint[];
        bucket: "day" | "week" | "month";
        seesProfit: boolean;
      }>(`/api/financials/trends?${buildRangeQuery(range)}`),
    staleTime: 60_000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Categories

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
  return useQuery({
    queryKey: ["fin", "categories"],
    queryFn: () =>
      api.request<{ data: FinanceCategoryNode[] }>(`/api/financials/categories`),
    select: (r) => r.data,
    staleTime: 10 * 60_000,
  });
}

/** Flatten the tree for a pickable list. Groups come first, their subcategories indented. */
export function flattenCategoryTree(
  tree: FinanceCategoryNode[] | undefined,
): { id: string; label: string; indent: number; isGroup: boolean; kind: FinanceCategoryNode["kind"] }[] {
  if (!tree) return [];
  const out: { id: string; label: string; indent: number; isGroup: boolean; kind: FinanceCategoryNode["kind"] }[] = [];
  for (const node of tree) {
    if (node.archivedAt) continue;
    out.push({ id: node.id, label: node.nameAr || node.nameEn, indent: 0, isGroup: true, kind: node.kind });
    for (const child of node.children) {
      if (child.archivedAt) continue;
      out.push({
        id: child.id,
        label: child.nameAr || child.nameEn,
        indent: 1,
        isGroup: false,
        kind: child.kind,
      });
    }
  }
  return out;
}

export interface CreateCategoryInput {
  parentId: string;
  slug: string;
  nameEn: string;
  nameAr: string;
}
export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCategoryInput) =>
      api.request<{ id: string }>(`/api/financials/categories`, {
        method: "POST",
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fin", "categories"] }),
  });
}

export function useRenameCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; nameEn?: string; nameAr?: string }) =>
      api.request<{ ok: true }>(`/api/financials/categories/${args.id}`, {
        method: "PATCH",
        body: { nameEn: args.nameEn, nameAr: args.nameAr },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fin", "categories"] }),
  });
}

export function useArchiveCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.request<{ ok: true }>(`/api/financials/categories/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fin", "categories"] }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Expenses (infinite list + CRUD)

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
  isRecurringTemplate?: boolean;
  limit?: number;
}

function buildExpenseQuery(f: FinanceExpensesListFilters, cursor?: string): string {
  const q = new URLSearchParams();
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (f.categoryId) q.set("categoryId", f.categoryId);
  if (f.paymentMethod) q.set("paymentMethod", f.paymentMethod);
  if (f.status) q.set("status", f.status);
  if (f.minAmount !== undefined) q.set("minAmount", String(f.minAmount));
  if (f.maxAmount !== undefined) q.set("maxAmount", String(f.maxAmount));
  if (f.search) q.set("search", f.search);
  if (f.isRecurringTemplate !== undefined)
    q.set("isRecurringTemplate", f.isRecurringTemplate ? "1" : "0");
  if (cursor) q.set("cursor", cursor);
  q.set("limit", String(f.limit ?? 30));
  return q.toString();
}

export function useFinanceExpenses(filters: FinanceExpensesListFilters) {
  return useInfiniteQuery({
    queryKey: ["fin", "expenses", filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.request<{ data: FinanceExpenseListItem[]; nextCursor: string | null }>(
        `/api/financials/expenses?${buildExpenseQuery(filters, pageParam)}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

export interface CreateExpenseInput {
  title: string;
  amount: number;
  date: string;
  categoryId?: string | null;
  paymentMethod?: string | null;
  referenceNumber?: string | null;
  note?: string | null;
  supplierId?: string | null;
  isRecurringTemplate?: boolean;
  recurrencePeriod?: "weekly" | "monthly" | "quarterly" | "yearly";
  nextOccurrenceDate?: string;
}

export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateExpenseInput) =>
      api.request<{ id: string }>(`/api/financials/expenses`, {
        method: "POST",
        body: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fin", "expenses"] });
      qc.invalidateQueries({ queryKey: ["fin", "overview"] });
      qc.invalidateQueries({ queryKey: ["fin", "pnl"] });
    },
  });
}

export interface UpdateExpenseInput {
  id: string;
  title?: string;
  amount?: number;
  date?: string;
  categoryId?: string | null;
  paymentMethod?: string | null;
  referenceNumber?: string | null;
  note?: string | null;
  supplierId?: string | null;
}

export function useUpdateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateExpenseInput) => {
      const { id, ...body } = input;
      return api.request<{ ok: true }>(`/api/financials/expenses/${id}`, {
        method: "PATCH",
        body,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fin", "expenses"] });
      qc.invalidateQueries({ queryKey: ["fin", "overview"] });
      qc.invalidateQueries({ queryKey: ["fin", "pnl"] });
    },
  });
}

export function useVoidExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; reason?: string }) =>
      api.request<{ ok: true }>(`/api/financials/expenses/${args.id}/void`, {
        method: "POST",
        body: { reason: args.reason },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fin", "expenses"] });
      qc.invalidateQueries({ queryKey: ["fin", "overview"] });
      qc.invalidateQueries({ queryKey: ["fin", "pnl"] });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Money movements

export type MoneyMovementKind =
  | "owner_deposit"
  | "owner_withdrawal"
  | "cash_transfer"
  | "loan_received"
  | "loan_principal_repayment"
  | "supplier_payment_direct"
  | "customer_deposit"
  | "other";

export const MONEY_MOVEMENT_KINDS: MoneyMovementKind[] = [
  "owner_deposit",
  "owner_withdrawal",
  "cash_transfer",
  "loan_received",
  "loan_principal_repayment",
  "supplier_payment_direct",
  "customer_deposit",
  "other",
];

// Directions for UI badges — match the backend's MONEY_OUT_KINDS set.
const MONEY_OUT_KINDS = new Set<MoneyMovementKind>([
  "owner_withdrawal",
  "cash_transfer",
  "loan_principal_repayment",
  "supplier_payment_direct",
]);
export function directionFor(kind: MoneyMovementKind): "in" | "out" {
  return MONEY_OUT_KINDS.has(kind) ? "out" : "in";
}

export interface MoneyMovementRow {
  id: string;
  kind: MoneyMovementKind;
  amount: number;
  occurredAt: string;
  description: string | null;
  paymentMethod: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface MoneyMovementsFilters {
  from?: string;
  to?: string;
  kind?: MoneyMovementKind;
  status?: "active" | "voided" | "any";
  limit?: number;
}

function buildMovementQuery(f: MoneyMovementsFilters, cursor?: string): string {
  const q = new URLSearchParams();
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (f.kind) q.set("kind", f.kind);
  if (f.status) q.set("status", f.status);
  if (cursor) q.set("cursor", cursor);
  q.set("limit", String(f.limit ?? 30));
  return q.toString();
}

export function useMoneyMovements(filters: MoneyMovementsFilters) {
  return useInfiniteQuery({
    queryKey: ["fin", "money-movements", filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.request<{ data: MoneyMovementRow[]; nextCursor: string | null }>(
        `/api/financials/money-movements?${buildMovementQuery(filters, pageParam)}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

export interface CreateMoneyMovementInput {
  kind: MoneyMovementKind;
  amount: number;
  occurredAt: string;
  description?: string;
  paymentMethod?: string;
}

export function useCreateMoneyMovement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMoneyMovementInput) =>
      api.request<{ id: string }>(`/api/financials/money-movements`, {
        method: "POST",
        body: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fin", "money-movements"] });
      qc.invalidateQueries({ queryKey: ["fin", "overview"] });
    },
  });
}

export function useVoidMoneyMovement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; reason?: string }) =>
      api.request<{ ok: true }>(
        `/api/financials/money-movements/${args.id}/void`,
        { method: "POST", body: { reason: args.reason } },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fin", "money-movements"] });
      qc.invalidateQueries({ queryKey: ["fin", "overview"] });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Profitability

export interface ProductProfitRow {
  productId: string;
  productName: string;
  brand: string | null;
  categoryId: string | null;
  categoryNameAr: string | null;
  quantitySold: number;
  revenue: number;
  cogs: number | null;
  grossProfit: number | null;
  margin: number | null;
}

export interface CategoryProfitRow {
  categoryId: string | null;
  categoryNameAr: string | null;
  categoryNameEn: string | null;
  quantitySold: number;
  revenue: number;
  cogs: number | null;
  grossProfit: number | null;
  margin: number | null;
}

export type ProfitSortKey = "revenue" | "grossProfit" | "margin" | "quantity";

// Server shape: `{ data, total, seesProfit, period }`. Guard with `?? []` in
// case a transient 500 returns an error body without `data` — the UI then
// just shows the empty state instead of throwing.
export function useProductProfitability(opts: {
  range: FinancialsRange;
  search?: string;
  sort?: ProfitSortKey;
  limit?: number;
}) {
  return useInfiniteQuery({
    queryKey: ["fin", "profitability", "products", opts],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams();
      q.set("preset", opts.range.preset);
      if (opts.range.preset === "custom") {
        if (opts.range.from) q.set("from", opts.range.from);
        if (opts.range.to) q.set("to", opts.range.to);
      }
      if (opts.search) q.set("search", opts.search);
      if (opts.sort) q.set("sort", opts.sort);
      q.set("limit", String(opts.limit ?? 30));
      q.set("offset", String(pageParam));
      return api.request<{ data: ProductProfitRow[]; total: number; seesProfit: boolean }>(
        `/api/financials/profitability/products?${q.toString()}`,
      );
    },
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((s, p) => s + (p.data?.length ?? 0), 0);
      return loaded < (last.total ?? 0) ? loaded : undefined;
    },
    staleTime: 60_000,
  });
}

export function useCategoryProfitability(opts: {
  range: FinancialsRange;
  sort?: ProfitSortKey;
}) {
  return useQuery({
    queryKey: ["fin", "profitability", "categories", opts],
    queryFn: () => {
      const q = new URLSearchParams();
      q.set("preset", opts.range.preset);
      if (opts.range.preset === "custom") {
        if (opts.range.from) q.set("from", opts.range.from);
        if (opts.range.to) q.set("to", opts.range.to);
      }
      if (opts.sort) q.set("sort", opts.sort);
      return api.request<{ data: CategoryProfitRow[]; seesProfit: boolean }>(
        `/api/financials/profitability/categories?${q.toString()}`,
      );
    },
    staleTime: 60_000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Recurring

export function useGenerateRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.request<{ spawned: number }>(`/api/financials/recurring/generate`, {
        method: "POST",
        body: {},
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fin", "expenses"] });
      qc.invalidateQueries({ queryKey: ["fin", "overview"] });
    },
  });
}
