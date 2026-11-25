// Phase 3 — Admin Control Center: per-tenant and platform-wide operational
// counts. All aggregates are exact SQL (no sampling), batched so showing N
// tenants is one query per signal, not N queries.
//
// Shapes
//  • TenantCounts            — single tenant: products, categories, customers, suppliers
//  • listTenantCounts(ids[]) — batched for the tenant list page
//  • getTenantTopCategories  — top N categories by product count for the detail page
//  • getPlatformAggregates   — platform-wide totals for the overview
//
// No branch_id in any new predicate — Phase 3 scoping is tenant-only even
// though the legacy schema still has branch columns on products/customers.

import { sql } from "drizzle-orm";
import { getAdminDb } from "./db";

export interface TenantCounts {
  products: number;
  categories: number;
  /** Distinct customer phones that have a wallet row for this tenant. */
  customers: number;
  suppliers: number;
}

export interface TenantCategoryBreakdown {
  categoryId: string;
  name: string;
  productCount: number;
}

export interface PlatformAggregates {
  totalProducts: number;
  totalCategories: number;
  totalCustomers: number;
  totalSuppliers: number;
  totalEmployees: number;
  /** Platform-wide active-paid tenants (subscriptions.status='active'). */
  totalActivePaid: number;
  totalSuspended: number;
  totalExpiredTrials: number;
}

function num(x: unknown): number {
  if (x == null) return 0;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function pickRows<T>(r: unknown): T[] {
  return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

/**
 * Batched counts for a set of tenant ids. 4 queries total (one per aggregate),
 * each grouped by tenant_id. Linear in tenants-per-page, not in queries.
 */
export async function listTenantCounts(
  tenantIds: string[],
): Promise<Map<string, TenantCounts>> {
  const out = new Map<string, TenantCounts>();
  if (tenantIds.length === 0) return out;
  const db = getAdminDb();

  // Postgres UUID array literal — the only safe way to pass N uuids to a
  // single ANY() without widening the parameter count.
  const arrayLit = sql.raw(
    `ARRAY[${tenantIds.map((id) => `'${id}'::uuid`).join(",")}]`,
  );

  type Row = { tenant_id: string; c: number | string };

  const [productRows, categoryRows, customerRows, supplierRows] =
    await Promise.all([
      db.execute(sql`
        SELECT tenant_id::text AS tenant_id, COUNT(*)::int AS c
        FROM products
        WHERE tenant_id = ANY(${arrayLit})
        GROUP BY tenant_id
      `) as unknown as Promise<Row[]>,
      db.execute(sql`
        SELECT tenant_id::text AS tenant_id, COUNT(*)::int AS c
        FROM categories
        WHERE tenant_id = ANY(${arrayLit})
        GROUP BY tenant_id
      `) as unknown as Promise<Row[]>,
      db.execute(sql`
        SELECT tenant_id::text AS tenant_id,
               COUNT(DISTINCT customer_phone)::int AS c
        FROM customer_wallets
        WHERE tenant_id = ANY(${arrayLit})
        GROUP BY tenant_id
      `) as unknown as Promise<Row[]>,
      db.execute(sql`
        SELECT tenant_id::text AS tenant_id, COUNT(*)::int AS c
        FROM suppliers
        WHERE tenant_id = ANY(${arrayLit})
        GROUP BY tenant_id
      `) as unknown as Promise<Row[]>,
    ]);

  const pm = new Map(pickRows<Row>(productRows).map((r) => [r.tenant_id, num(r.c)]));
  const cm = new Map(pickRows<Row>(categoryRows).map((r) => [r.tenant_id, num(r.c)]));
  const custm = new Map(pickRows<Row>(customerRows).map((r) => [r.tenant_id, num(r.c)]));
  const sm = new Map(pickRows<Row>(supplierRows).map((r) => [r.tenant_id, num(r.c)]));

  for (const id of tenantIds) {
    out.set(id, {
      products: pm.get(id) ?? 0,
      categories: cm.get(id) ?? 0,
      customers: custm.get(id) ?? 0,
      suppliers: sm.get(id) ?? 0,
    });
  }
  return out;
}

/** Single-tenant convenience — for the detail page where we don't need
 *  to batch. Reuses the batch function; one call is cheap. */
export async function getTenantCounts(
  tenantId: string,
): Promise<TenantCounts> {
  const map = await listTenantCounts([tenantId]);
  return (
    map.get(tenantId) ?? {
      products: 0,
      categories: 0,
      customers: 0,
      suppliers: 0,
    }
  );
}

/**
 * Top N categories (by product count) for one tenant. Fed into the Usage
 * card on the store detail page. Returns [] when the tenant has no products.
 */
export async function getTenantTopCategories(
  tenantId: string,
  limit = 8,
): Promise<TenantCategoryBreakdown[]> {
  const db = getAdminDb();
  type Row = { category_id: string; name: string; c: number | string };
  const rows = (await db.execute(sql`
    SELECT c.id::text AS category_id,
           c.label AS name,
           COUNT(p.id)::int AS c
    FROM categories c
    LEFT JOIN products p
      ON p.category_id = c.id
      AND p.tenant_id = c.tenant_id
    WHERE c.tenant_id = ${tenantId}
    GROUP BY c.id, c.label
    ORDER BY COUNT(p.id) DESC, c.label ASC
    LIMIT ${limit}
  `)) as unknown as Row[];
  return pickRows<Row>(rows).map((r) => ({
    categoryId: r.category_id,
    name: r.name,
    productCount: num(r.c),
  }));
}

/**
 * Platform-wide aggregates for the admin Overview. One Promise.all; each
 * query is a bare COUNT(*). Fast even at 10k+ tenants.
 */
export async function getPlatformAggregates(): Promise<PlatformAggregates> {
  const db = getAdminDb();
  type C = { c: number | string };

  const [
    products,
    categories,
    customers,
    suppliers,
    employees,
    activePaid,
    suspended,
    expired,
  ] = await Promise.all([
    db.execute(sql`SELECT COUNT(*)::int AS c FROM products`) as unknown as Promise<C[]>,
    db.execute(sql`SELECT COUNT(*)::int AS c FROM categories`) as unknown as Promise<C[]>,
    db.execute(sql`
      SELECT COUNT(*)::int AS c FROM (
        SELECT DISTINCT tenant_id, customer_phone FROM customer_wallets
      ) u
    `) as unknown as Promise<C[]>,
    db.execute(sql`SELECT COUNT(*)::int AS c FROM suppliers`) as unknown as Promise<C[]>,
    db.execute(sql`
      SELECT COUNT(DISTINCT user_id)::int AS c FROM tenant_members
    `) as unknown as Promise<C[]>,
    db.execute(sql`
      SELECT COUNT(*)::int AS c FROM subscriptions WHERE status = 'active'
    `) as unknown as Promise<C[]>,
    db.execute(sql`
      SELECT COUNT(*)::int AS c FROM tenants WHERE suspended_at IS NOT NULL
    `) as unknown as Promise<C[]>,
    db.execute(sql`
      SELECT COUNT(*)::int AS c FROM subscriptions WHERE status = 'expired'
    `) as unknown as Promise<C[]>,
  ]);

  return {
    totalProducts: num(pickRows<C>(products)[0]?.c),
    totalCategories: num(pickRows<C>(categories)[0]?.c),
    totalCustomers: num(pickRows<C>(customers)[0]?.c),
    totalSuppliers: num(pickRows<C>(suppliers)[0]?.c),
    totalEmployees: num(pickRows<C>(employees)[0]?.c),
    totalActivePaid: num(pickRows<C>(activePaid)[0]?.c),
    totalSuspended: num(pickRows<C>(suspended)[0]?.c),
    totalExpiredTrials: num(pickRows<C>(expired)[0]?.c),
  };
}
