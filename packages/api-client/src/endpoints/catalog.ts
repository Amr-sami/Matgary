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
