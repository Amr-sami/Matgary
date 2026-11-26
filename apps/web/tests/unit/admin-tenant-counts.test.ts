/**
 * Phase 3 — per-tenant and platform count aggregators against real
 * Postgres. Verifies:
 *   • listTenantCounts batches by tenant_id and returns exact products /
 *     categories / customers / suppliers per tenant.
 *   • getTenantTopCategories orders by product count DESC and returns the
 *     category label (not key or id string).
 *   • getPlatformAggregates returns totals across the whole platform.
 *
 * Fixture strategy: seed one tenant with a known set of products,
 * categories, customers, suppliers. Sum the counts delta before/after.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getAdminDb } from "@/lib/admin/db";
import {
  getPlatformAggregates,
  getTenantCounts,
  getTenantTopCategories,
  listTenantCounts,
} from "@/lib/admin/tenant-counts";

const PREFIX = "counts-" + Math.random().toString(36).slice(2, 8);
let TENANT_ID = "";
let BRANCH_ID = "";
let CAT_IDS: string[] = [];

async function row<T>(q: Promise<unknown>): Promise<T | undefined> {
  const r = (await q) as unknown;
  const arr = Array.isArray(r)
    ? (r as T[])
    : ((r as { rows?: T[] }).rows ?? []);
  return arr[0];
}

beforeAll(async () => {
  const db = getAdminDb();
  const tenant = await row<{ id: string }>(db.execute(sql`
    INSERT INTO tenants (name, slug) VALUES (${"T " + PREFIX}, ${PREFIX + "-s"})
    RETURNING id::text AS id
  `));
  TENANT_ID = tenant!.id;
  const branch = await row<{ id: string }>(db.execute(sql`
    INSERT INTO branches (tenant_id, slug, name, is_active, is_primary)
    VALUES (${TENANT_ID}, ${PREFIX + "-main"}, 'main', true, true)
    RETURNING id::text AS id
  `));
  BRANCH_ID = branch!.id;

  // 3 categories, labelled so we can check ordering.
  const seedCat = async (key: string, label: string) => {
    const r = await row<{ id: string }>(db.execute(sql`
      INSERT INTO categories (tenant_id, branch_id, key, label)
      VALUES (${TENANT_ID}, ${BRANCH_ID}, ${key}, ${label})
      RETURNING id::text AS id
    `));
    return r!.id;
  };
  CAT_IDS = [
    await seedCat(PREFIX + "-cat-a", "Alpha"),
    await seedCat(PREFIX + "-cat-b", "Beta"),
    await seedCat(PREFIX + "-cat-c", "Gamma"),
  ];

  // Products: 5 in Alpha, 2 in Beta, 0 in Gamma.
  const seedProduct = async (catId: string, n: number) => {
    for (let i = 0; i < n; i += 1) {
      await db.execute(sql`
        INSERT INTO products (tenant_id, branch_id, category_id, name, price, quantity)
        VALUES (${TENANT_ID}, ${BRANCH_ID}, ${catId}, ${`p-${PREFIX}-${i}`}, '10', 1)
      `);
    }
  };
  await seedProduct(CAT_IDS[0], 5);
  await seedProduct(CAT_IDS[1], 2);

  // 3 distinct customers (wallets).
  for (let i = 0; i < 3; i += 1) {
    await db.execute(sql`
      INSERT INTO customer_wallets (tenant_id, branch_id, customer_phone, customer_name)
      VALUES (${TENANT_ID}, ${BRANCH_ID}, ${"+2010000" + PREFIX.slice(0, 4) + i}, ${"C" + i})
    `);
  }

  // 2 suppliers (legacy branch_id column is NOT NULL — fill it with the
  // tenant's primary branch; the Phase 3 aggregator ignores branch_id).
  for (let i = 0; i < 2; i += 1) {
    await db.execute(sql`
      INSERT INTO suppliers (tenant_id, branch_id, name)
      VALUES (${TENANT_ID}, ${BRANCH_ID}, ${"S-" + PREFIX + "-" + i})
    `);
  }
}, 30_000);

afterAll(async () => {
  const db = getAdminDb();
  // Tenant CASCADE removes branches, products, categories, wallets, suppliers.
  await db.execute(sql`DELETE FROM tenants WHERE id = ${TENANT_ID}`);
}, 10_000);

describe("listTenantCounts (batched)", () => {
  it("returns exact products / categories / customers / suppliers", async () => {
    const map = await listTenantCounts([TENANT_ID]);
    expect(map.get(TENANT_ID)).toEqual({
      products: 7,
      categories: 3,
      customers: 3,
      suppliers: 2,
    });
  });

  it("handles unknown tenant ids by returning zeros", async () => {
    const map = await listTenantCounts([
      "00000000-0000-0000-0000-000000000000",
    ]);
    expect(map.get("00000000-0000-0000-0000-000000000000")).toEqual({
      products: 0,
      categories: 0,
      customers: 0,
      suppliers: 0,
    });
  });
});

describe("getTenantCounts (single)", () => {
  it("returns same shape as the batch helper", async () => {
    const r = await getTenantCounts(TENANT_ID);
    expect(r).toEqual({
      products: 7,
      categories: 3,
      customers: 3,
      suppliers: 2,
    });
  });
});

describe("getTenantTopCategories", () => {
  it("orders by product count DESC and returns category labels", async () => {
    const rows = await getTenantTopCategories(TENANT_ID);
    // Keep only our categories (test may run alongside other tenants).
    const own = rows.filter((r) => CAT_IDS.includes(r.categoryId));
    expect(own).toHaveLength(3);
    expect(own[0]).toEqual({
      categoryId: CAT_IDS[0],
      name: "Alpha",
      productCount: 5,
    });
    expect(own[1]).toEqual({
      categoryId: CAT_IDS[1],
      name: "Beta",
      productCount: 2,
    });
    expect(own[2]).toEqual({
      categoryId: CAT_IDS[2],
      name: "Gamma",
      productCount: 0,
    });
  });
});

describe("getPlatformAggregates", () => {
  it("includes our seed counts (platform-wide totals ≥ fixture)", async () => {
    const a = await getPlatformAggregates();
    expect(a.totalProducts).toBeGreaterThanOrEqual(7);
    expect(a.totalCategories).toBeGreaterThanOrEqual(3);
    expect(a.totalCustomers).toBeGreaterThanOrEqual(3);
    expect(a.totalSuppliers).toBeGreaterThanOrEqual(2);
  });
});
