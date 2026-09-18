import type { ApiClient } from "../http";
import type {
  Brand,
  Category,
  Expense,
  ListEnvelope,
  Product,
  PurchaseOrder,
  ReturnRecord,
  SaleLine,
  Supplier,
  Task,
  TeamMember,
  CustomerSummary,
} from "../types";

/**
 * Thin readers over the existing web API.
 *
 * Deliberately not reimplemented under /api/v1: these handlers already enforce
 * tenant isolation, branch scoping and permissions, and duplicating them would
 * create two places for the same rule to drift. The only thing Phase 0 had to
 * add was bearer auth, which they inherited.
 *
 * Every one of them answers `{ data, branchId }`, so the envelope is unwrapped
 * here rather than in each screen.
 */
async function list<T>(client: ApiClient, path: string): Promise<T[]> {
  const res = await client.request<ListEnvelope<T>>(path);
  return res.data ?? [];
}

export const listProducts = (c: ApiClient) => list<Product>(c, "/api/products");
export const listSales = (c: ApiClient) => list<SaleLine>(c, "/api/sales");
export const listPurchaseOrders = (c: ApiClient) =>
  list<PurchaseOrder>(c, "/api/purchase-orders");
export const listSuppliers = (c: ApiClient) => list<Supplier>(c, "/api/suppliers");
export const listExpenses = (c: ApiClient) => list<Expense>(c, "/api/expenses");
export const listTasks = (c: ApiClient) => list<Task>(c, "/api/tasks");
export const listCategories = (c: ApiClient) => list<Category>(c, "/api/categories");
export const listBrands = (c: ApiClient) => list<Brand>(c, "/api/brands");
export const listReturns = (c: ApiClient) => list<ReturnRecord>(c, "/api/returns");

export const listTeam = (c: ApiClient) => list<TeamMember>(c, "/api/team");

/**
 * Customers are AGGREGATED from sales, not stored as rows — there is no
 * customers table to read. The v1 route does the grouping in SQL and paginates
 * by cursor; this reads the first page, which is what the list screen shows.
 */
export async function listCustomers(c: ApiClient): Promise<CustomerSummary[]> {
  const res = await c.request<{ data: CustomerSummary[] }>("/api/v1/customers");
  return res.data ?? [];
}

/** One keyset page of /api/v1/customers. `q` matches name or phone. */
export interface CustomerPage {
  data: CustomerSummary[];
  nextCursor: string | null;
  /**
   * Count of DISTINCT customers matching `q` across the whole branch. The
   * route computes it on the first page only (continuation pages carry null),
   * so a screen reads `pages[0].total` for its header and never `data.length`,
   * which is just the rows loaded so far.
   */
  total: number | null;
}

/**
 * Same route, but exposing the cursor so the list can keep paging, and `q`
 * so search runs in SQL instead of over whatever page happens to be loaded.
 */
export async function listCustomersPage(
  c: ApiClient,
  opts: { q?: string; cursor?: string | null; limit?: number } = {},
): Promise<CustomerPage> {
  const res = await c.request<{
    data: CustomerSummary[];
    nextCursor?: string | null;
    total?: number | null;
  }>(
    "/api/v1/customers",
    {
      query: {
        q: opts.q?.trim() || undefined,
        cursor: opts.cursor ?? undefined,
        limit: opts.limit,
      },
    },
  );
  return { data: res.data ?? [], nextCursor: res.nextCursor ?? null, total: res.total ?? null };
}

// ---- Customer detail -------------------------------------------------------
//
// apps/web/lib/repo/customers.ts — LedgerInvoice, serialised. Phones are
// canonicalised server-side (normalizeEgyptPhone); the client sends whatever
// the list returned, which already is canonical.

export interface CustomerLedgerLine {
  saleId: string;
  productName: string;
  quantity: number;
  pricePerUnit: number;
  lineTotal: number;
}

export interface CustomerLedgerInvoice {
  invoiceId: string;
  saleIds: string[];
  date: string;
  total: number;
  /** Migration 0037: cash collected against this invoice, 0 ≤ x ≤ total. */
  amountPaid: number;
  /** total − amountPaid, pre-computed server-side. */
  balance: number;
  isPaid: boolean;
  paidAt: string | null;
  paymentMethod: string | null;
  lines: CustomerLedgerLine[];
}

export interface CustomerLedger {
  customerName: string | null;
  customerPhone: string;
  invoiceCount: number;
  lifetimeValue: number;
  outstandingBalance: number;
  paidBalance: number;
  firstVisit: string | null;
  lastVisit: string | null;
  invoices: CustomerLedgerInvoice[];
}

export interface CustomerLedgerResponse {
  data: CustomerLedger;
  branchId: string;
  branchName: string;
}

/**
 * GET /api/customers/by-phone/[phone]. A 404 means "no invoices for this
 * customer in the active branch" — a designed state, not a failure — so the
 * caller decides how to render `null`.
 */
export const getCustomerLedger = (c: ApiClient, phone: string) =>
  c.request<CustomerLedgerResponse>(`/api/customers/by-phone/${encodeURIComponent(phone)}`);

/** Migration 0038 — one row per settle action. */
export interface CustomerPaymentEvent {
  id: string;
  saleId: string;
  invoiceId: string | null;
  amount: number;
  method: string;
  recordedAt: string;
  note: string | null;
  recordedByName: string | null;
}

export async function listCustomerPayments(
  c: ApiClient,
  phone: string,
): Promise<CustomerPaymentEvent[]> {
  const res = await c.request<{ data: CustomerPaymentEvent[] }>(
    `/api/customers/by-phone/${encodeURIComponent(phone)}/payments`,
  );
  return res.data ?? [];
}

/** apps/web/lib/repo/loyalty.ts — getWallet. Zero balances when no row yet. */
export interface CustomerWallet {
  customerPhone: string;
  customerName: string | null;
  points: number;
  credit: number;
  updatedAt: string;
}

export interface CustomerWalletEvent {
  id: string;
  kind: string;
  pointsDelta: number;
  creditDelta: number;
  reason: string | null;
  createdAt: string;
}

export interface CustomerWalletResponse {
  wallet: CustomerWallet;
  events: CustomerWalletEvent[];
  branchId: string;
  branchName: string;
}

export const getCustomerWallet = (c: ApiClient, phone: string) =>
  c.request<CustomerWalletResponse>(
    `/api/customers/by-phone/${encodeURIComponent(phone)}/wallet`,
  );

/** apps/web/app/api/sales/settle/route.ts — zod enum, closed. */
export type SettlementMethod = "cash" | "instapay" | "card";

export interface SettleCustomerInput {
  customerPhone: string;
  /** Positive; anything above the invoice balance is returned as `overpay`. */
  amount: number;
  method: SettlementMethod;
  /** Omit to apply oldest-first across every unpaid invoice. */
  invoiceIds?: string[];
}

/** lib/repo/operations.ts — SettleCustomerPaymentResult. */
export interface SettleCustomerResult {
  appliedAmount: number;
  overpay: number;
  fullySettledInvoices: number;
  newBalance: number;
}

/**
 * POST /api/sales/settle. Records a (partial) payment against one or more
 * invoices; cash settlements land on the open cash shift so the Z-report
 * sees them. Server errors carry a code in `error` (NOTHING_TO_SETTLE, …)
 * that maps onto app.customers.settle.errors.*.
 */
export const settleCustomer = (c: ApiClient, input: SettleCustomerInput) =>
  c.request<SettleCustomerResult>("/api/sales/settle", { method: "POST", body: input });

export interface MarkAllPaidResult {
  markedCount: number;
  markedTotal: number;
}

/**
 * POST /api/customers/by-phone/[phone]/mark-all-paid — every unpaid sale for
 * (active branch, phone) becomes paid, atomically. Idempotent. Requires
 * `modify_sales`.
 */
export const markCustomerAllPaid = (c: ApiClient, phone: string) =>
  c.request<MarkAllPaidResult>(
    `/api/customers/by-phone/${encodeURIComponent(phone)}/mark-all-paid`,
    { method: "POST" },
  );

// ---------------------------------------------------------------------------
// Writes.
//
// Same reasoning as the readers above: these are the web's own handlers, which
// already enforce tenant isolation, branch scoping and (where they check at
// all) permissions. The payload shapes below mirror the zod schema in each
// route file 1:1 — anything the schema rejects is not offered here, because a
// field the server drops silently is worse than one that never existed.
// ---------------------------------------------------------------------------

/** apps/web/app/api/expenses/route.ts — a closed enum, NOT free text. */
export type ExpenseCategory =
  | "rent"
  | "salaries"
  | "electricity"
  | "water"
  | "internet"
  | "supplier"
  | "other";

export interface CreateExpenseInput {
  title: string;
  amount: number;
  category: ExpenseCategory;
  supplierId?: string | null;
  isRecurring?: boolean;
  recurrencePeriod?: "monthly" | "weekly" | null;
  /** ISO datetime. Omitted = now, server-side. */
  date?: string;
  note?: string;
  /**
   * Omit to book against the active branch (X-Branch-Id). An explicit `null`
   * means tenant-wide and is OWNER-ONLY — the server answers 403
   * TENANT_WIDE_EXPENSE_OWNER_ONLY for anyone else.
   */
  branchId?: string | null;
}

/**
 * POST /api/expenses — 201.
 *
 * The body is `{ id }` only, not the created row: `addExpense` returns the
 * insert's returning-id. Measured against the dev server, not assumed. Callers
 * refetch the list rather than splicing a response row in.
 */
export const createExpense = (c: ApiClient, input: CreateExpenseInput) =>
  c.request<{ id: string }>("/api/expenses", { method: "POST", body: input });

export type TaskPriority = "low" | "normal" | "high";
export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  /** From listTeam(). Null/omitted leaves the task unassigned. */
  assignedToUserId?: string | null;
  priority?: TaskPriority;
  /** ISO datetime, or null. */
  dueDate?: string | null;
}

/**
 * POST /api/tasks — 201. Like createExpense, the body is `{ id }` only.
 *
 * Requires `manage_tasks` (owners bypass); a plain cashier gets 403 Forbidden.
 * A 409 carries an Arabic message, e.g. when the assignee is not in the tenant.
 */
export const createTask = (c: ApiClient, input: CreateTaskInput) =>
  c.request<{ id: string }>("/api/tasks", { method: "POST", body: input });

/**
 * PATCH /api/tasks/[id] — the done/reopen toggle.
 *
 * The body must be EXACTLY `{ status }`: the route's schema is `.strict()`, so
 * one extra key is a 400, and a status-only patch is the single edit the
 * assignee themselves is allowed to make without `manage_tasks`. Sending any
 * second field turns this into a manager-only call.
 */
export const setTaskStatus = (c: ApiClient, id: string, status: TaskStatus) =>
  c.request<{ ok: true }>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { status },
  });

/**
 * apps/web/app/api/products/route.ts createSchema.
 *
 * `categoryId`, not `category`: GET /api/products returns the category id in a
 * field literally named `category`, so round-tripping a fetched product into
 * this shape without renaming is a 400 that typechecking cannot catch.
 */
export interface CreateProductInput {
  name: string;
  categoryId: string;
  brand?: string;
  quantity: number;
  price: number;
  costPrice?: number;
  lowStockThreshold?: number;
  sku?: string;
  tags?: string[];
  supplierId?: string | null;
}

export const createProduct = (c: ApiClient, input: CreateProductInput) =>
  c.request<{ id: string }>("/api/products", { method: "POST", body: input });

/** apps/web/app/api/returns/route.ts — a return is against ONE sale line. `reason` is required. */
export interface CreateReturnInput {
  saleId: string;
  productId: string;
  returnedQuantity: number;
  reason: string;
}
export const createReturn = (c: ApiClient, input: CreateReturnInput) =>
  c.request<{ id: string }>("/api/returns", { method: "POST", body: input });

/** apps/web/app/api/purchase-orders/route.ts. `productName` is required even with a productId. */
export interface CreatePurchaseOrderInput {
  supplierId: string;
  notes?: string | null;
  items: { productId?: string | null; productName: string; quantity: number; unitCost: number }[];
}
export const createPurchaseOrder = (c: ApiClient, input: CreatePurchaseOrderInput) =>
  c.request<{ id: string }>("/api/purchase-orders", { method: "POST", body: input });

export const deleteProduct = (c: ApiClient, id: string) =>
  c.request<unknown>(`/api/products/${id}`, { method: "DELETE" });

// ---------------------------------------------------------------------------
// Scanner lookup.
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/products?barcode=<code> — apps/web/app/api/v1/products/route.ts.
 *
 * The server does the normalisation (`normalizeSku`: decoder junk stripped,
 * case-folded, UPC-A ↔ EAN-13 collapsed) on BOTH the scanned code and every
 * stored sku, so the client sends the raw decoder output untouched. Answers
 * `{ data: Product[] (0 or 1), nextCursor: null, total }` — zero matches is a
 * 200 with an empty array, never a 404, so an unknown barcode is a normal
 * result here and not an ApiError. `total` can exceed 1 when two rows share
 * the code; the server hands back the in-stock one.
 *
 * An out-of-stock product still comes back (quantity 0) — the caller decides
 * whether that is "top up stock" or "not sellable", not this function.
 */
export interface BarcodeLookup {
  product: Product | null;
  /** Matches across the branch's catalogue, which can be more than `product`. */
  total: number;
}

export async function findProductByBarcode(
  c: ApiClient,
  code: string,
): Promise<BarcodeLookup> {
  const res = await c.request<{ data: Product[]; nextCursor: null; total: number }>(
    `/api/v1/products?barcode=${encodeURIComponent(code)}`,
  );
  return { product: res.data?.[0] ?? null, total: res.total ?? 0 };
}

// ---------------------------------------------------------------------------
// Suppliers — apps/web/app/api/suppliers/route.ts and /[id]/route.ts.
// ---------------------------------------------------------------------------

/**
 * createSchema / patchSchema, which are the same shape except that PATCH makes
 * `name` optional too. Only `name` is required; the rest are nullable, and the
 * server coerces "" to null itself, so blank inputs may be sent as-is. `email`
 * must be a real address when non-empty (zod `.email()`) — otherwise a 400
 * whose `error` is zod's English message, so the client validates first.
 */
export interface SupplierInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
}

/**
 * POST /api/suppliers — 201, body `{ id }` only (addSupplier returns the
 * insert's returning-id). Requires `manage_suppliers` and books against the
 * active branch (X-Branch-Id); no branch access is a 403 NO_BRANCH_ACCESS.
 */
export const createSupplier = (c: ApiClient, input: SupplierInput) =>
  c.request<{ id: string }>("/api/suppliers", { method: "POST", body: input });

/** PATCH /api/suppliers/[id] — every field optional; answers `{ ok: true }`. */
export const updateSupplier = (c: ApiClient, id: string, patch: Partial<SupplierInput>) =>
  c.request<{ ok: true }>(`/api/suppliers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
  });

/**
 * DELETE /api/suppliers/[id] — `{ ok: true }`, or a 409 whose `error` is an
 * Arabic sentence when purchase orders / expenses still reference the supplier.
 */
export const deleteSupplier = (c: ApiClient, id: string) =>
  c.request<{ ok: true }>(`/api/suppliers/${encodeURIComponent(id)}`, { method: "DELETE" });

// ---------------------------------------------------------------------------
// Product detail: stock adjustment, history, and the price/threshold patch.
// ---------------------------------------------------------------------------

/**
 * POST /api/products/[id]/adjust — apps/web/app/api/products/[id]/adjust/route.ts.
 *
 * The body is EXACTLY `{ delta }` (a signed integer): the schema has no
 * reason/note field, and an extra key is silently dropped — measured, so no
 * `note` is offered here. The server clamps at zero (`max(0, qty + delta)`)
 * and answers the clamped quantity, which is why callers read `newQuantity`
 * back instead of assuming `qty + delta`. Lands at the ACTIVE branch
 * (X-Branch-Id); the repo verifies the product belongs to it. Unknown id → 404
 * with an Arabic message. A delta of 0 still writes a history row, so the UI
 * must not send one.
 *
 * Permission: the route itself only requires a tenant + branch; the web hides
 * the ± controls behind `manage_inventory`, and the app does the same.
 */
export const adjustProductQuantity = (c: ApiClient, id: string, delta: number) =>
  c.request<{ newQuantity: number }>(`/api/products/${encodeURIComponent(id)}/adjust`, {
    method: "POST",
    body: { delta },
  });

/** One row of product_history — apps/web/lib/repo/catalog.ts listProductHistory(). */
export interface ProductHistoryEvent {
  id: string;
  productId: string;
  productName: string;
  type: "created" | "updated" | "restocked" | "decreased" | "sold" | "returned";
  /** Signed. Absent for `created` / `updated`. */
  delta?: number;
  quantityAfter?: number;
  note?: string;
  /** ISO datetime. */
  createdAt: string;
}

/**
 * GET /api/products/[id]/history — newest first, `{ data: ProductHistoryEvent[] }`.
 * Tenant-scoped, not branch-scoped, and an unknown id is an empty list, not a 404.
 */
export async function listProductHistory(
  c: ApiClient,
  id: string,
): Promise<ProductHistoryEvent[]> {
  const res = await c.request<{ data: ProductHistoryEvent[] }>(
    `/api/products/${encodeURIComponent(id)}/history`,
  );
  return res.data ?? [];
}

/**
 * apps/web/app/api/products/[id]/route.ts patchSchema — every key optional.
 * Not `.strict()`, but only what the schema names is sent through; the rest of
 * the schema (name, brand, sku, tags, supplierId, location, categoryId,
 * quantity) is deliberately not exposed by the detail screen — stock goes
 * through `adjustProductQuantity` so a history row is written.
 */
export interface UpdateProductInput {
  price?: number;
  costPrice?: number | null;
  lowStockThreshold?: number;
}

/** PATCH /api/products/[id] — `{ ok: true }`; a failed check is a 400 with the zod message. */
export const updateProduct = (c: ApiClient, id: string, input: UpdateProductInput) =>
  c.request<{ ok: true }>(`/api/products/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
  });
