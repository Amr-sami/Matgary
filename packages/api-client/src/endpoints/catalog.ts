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
