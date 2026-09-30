import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { db, withTenant } from "@/lib/db";
import {
  tenants,
  tenantMembers,
  users,
  shopSettings,
  categories,
  brands,
  products,
  branches,
  collectionAccounts,
  collections,
  collectionEvents,
} from "@/lib/db/schema";
import { isUniqueViolation } from "@/lib/api/idempotency";
import { addProduct, deleteProduct, listProducts, updateProduct } from "@/lib/repo/catalog";
import {
  addExpense,
  listExpenses,
  listReturns,
  listSales,
  recordReturn,
  recordSale,
  voidSale,
} from "@/lib/repo/operations";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";

// Admin connection used only by the test wipe; the app uses APP_DATABASE_URL.
const adminClient = postgres(process.env.DATABASE_URL!, { max: 1 });
const adminDb = drizzle(adminClient);

let tenantA: string;
let tenantB: string;
let userA: string;
let userB: string;
let productA: string;
let branchA: string;
let branchB: string;

/** Postgres SQLSTATE of a postgres.js error, possibly wrapped by drizzle in `cause`. */
function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.code ?? e?.cause?.code;
}
async function pgFails(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (err) { return err; }
  throw new Error("expected the statement to fail");
}

async function freshTenant(name: string, email: string) {
  return db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email, name, passwordHash: "x" })
      .returning({ id: users.id });
    const slug = `iso-${Math.random().toString(36).slice(2, 8)}`;
    const [t] = await tx
      .insert(tenants)
      .values({ name, slug })
      .returning({ id: tenants.id });
    // Set the RLS GUC up front so every downstream INSERT (branches,
    // shop_settings, the cornerstore seed) passes the WITH CHECK clause.
    // Done immediately after we know the tenant id — the FORCE ROW LEVEL
    // SECURITY policy on `branches` rejects writes when app.tenant_id is
    // unset, so the original order (branches → set_config → settings)
    // failed on the very first insert.
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    // Every tenant needs a primary branch — production signup creates one,
    // tests have to do it explicitly because they bypass signupAction.
    const [b] = await tx
      .insert(branches)
      .values({
        tenantId: t.id,
        slug: "main",
        name: "الفرع الرئيسي",
        isPrimary: true,
      })
      .returning({ id: branches.id });
    await tx.insert(tenantMembers).values({
      tenantId: t.id,
      userId: u.id,
      role: "owner",
    });
    await tx.insert(shopSettings).values({
      tenantId: t.id,
      branchId: b.id,
      shopName: name,
    });
    await seedCornerStorePreset(tx, t.id, b.id);
    return { tenantId: t.id, userId: u.id, branchId: b.id };
  });
}

beforeAll(async () => {
  // SAFETY GUARD — the wipe below truncates every meaningful table. Running it
  // against a dev database that's also used by `npm run dev` will erase every
  // real account, tenant, product, sale, etc. (Lesson learned the hard way.)
  // Refuse to run unless the operator opts in via TEST_DB_WIPE=1 *and* the URL
  // contains "test" — both conditions must hold so a forgotten env var alone
  // can't unlock destruction.
  const url = process.env.DATABASE_URL ?? "";
  const optedIn = process.env.TEST_DB_WIPE === "1";
  const looksLikeTestDb = /(?:^|[/_\-])test(?:[/_\-]|$)/i.test(url);
  if (!optedIn || !looksLikeTestDb) {
    throw new Error(
      [
        "Refusing to run the destructive isolation test wipe.",
        "This suite TRUNCATEs users/tenants/products/sales — running it against",
        `a non-test database would destroy real data. (DATABASE_URL=${url})`,
        "",
        "To run intentionally:",
        "  1. Point DATABASE_URL at a database whose name contains 'test'",
        "     (e.g. postgres://.../matgary_test).",
        "  2. Export TEST_DB_WIPE=1.",
      ].join("\n"),
    );
  }
  await adminDb.execute(sql`
    truncate
      returns, sales, expenses,
      product_attribute_values, product_history, products,
      brands, category_attribute_values, category_attributes, categories,
      shop_settings, tenant_members, branches,
      sessions, accounts, users, tenants
    restart identity cascade
  `);

  const a = await freshTenant("Tenant A", `a-${Date.now()}@iso.test`);
  const b = await freshTenant("Tenant B", `b-${Date.now()}@iso.test`);
  tenantA = a.tenantId;
  userA = a.userId;
  branchA = a.branchId;
  tenantB = b.tenantId;
  userB = b.userId;
  branchB = b.branchId;

  // Seed a product into A using A's catalog (resolved via the cornerstore preset).
  const aCats = await withTenant(tenantA, (tx) =>
    tx
      .select({ id: categories.id, key: categories.key })
      .from(categories)
      .where(sql`${categories.tenantId} = ${tenantA}`),
  );
  const watches = aCats.find((c) => c.key === "watches")!;

  const created = await addProduct(tenantA, branchA, {
    name: "Tenant-A Watch",
    categoryId: watches.id,
    quantity: 5,
    price: 100,
    lowStockThreshold: 2,
  });
  productA = created.id;
});

afterAll(async () => {
  await adminClient.end();
  const pg = (globalThis as unknown as { __pg?: { end: () => Promise<void> } }).__pg;
  await pg?.end();
});

describe("tenant isolation", () => {
  it("tenant B cannot see tenant A's products via the repo", async () => {
    const list = await listProducts(tenantB);
    expect(list).toHaveLength(0);
  });

  it("tenant B cannot see tenant A's categories via raw query under B's RLS context", async () => {
    const result = await withTenant(tenantB, (tx) =>
      tx.select().from(categories).where(sql`${categories.tenantId} = ${tenantA}`),
    );
    expect(result).toHaveLength(0);
  });

  it("tenant B cannot see tenant A's brands", async () => {
    const result = await withTenant(tenantB, (tx) =>
      tx.select().from(brands).where(sql`${brands.tenantId} = ${tenantA}`),
    );
    expect(result).toHaveLength(0);
  });

  it("tenant B updateProduct on A's product is a no-op (row invisible)", async () => {
    await updateProduct(tenantB, productA, { name: "hijacked" });
    // A's product is unchanged
    const aList = await listProducts(tenantA);
    const stillThere = aList.find((p) => p.id === productA);
    expect(stillThere?.name).toBe("Tenant-A Watch");
  });

  it("tenant B deleteProduct on A's product is a no-op (row invisible)", async () => {
    await deleteProduct(tenantB, productA);
    const aList = await listProducts(tenantA);
    expect(aList.find((p) => p.id === productA)).toBeDefined();
  });

  it("raw select with no app.tenant_id set returns 0 rows on RLS-protected tables", async () => {
    // Open a fresh transaction without setting app.tenant_id — RLS should hide everything.
    const result = await db.transaction(async (tx) => {
      // Force a clear of any session-level setting; LOCAL settings only live
      // for the lifetime of the tx, which is empty here.
      return tx.select().from(products);
    });
    expect(result).toHaveLength(0);
  });

  it("each tenant sees only its own products in listProducts", async () => {
    const aList = await listProducts(tenantA);
    const bList = await listProducts(tenantB);
    expect(aList.every((p) => p.id === productA)).toBe(true);
    expect(bList).toHaveLength(0);
  });
});

describe("operations isolation", () => {
  let saleA: string;

  it("tenant A records a sale + expense; tenant B sees neither", async () => {
    const sale = await recordSale(tenantA, {
      productId: productA,
      quantitySold: 2,
      pricePerUnit: 100,
      branchId: branchA,
    });
    saleA = sale.saleId;

    await addExpense(tenantA, {
      title: "Rent",
      amount: 5000,
      category: "rent",
    });

    const aSales = await listSales(tenantA);
    const bSales = await listSales(tenantB);
    expect(aSales).toHaveLength(1);
    expect(bSales).toHaveLength(0);

    const aExp = await listExpenses(tenantA);
    const bExp = await listExpenses(tenantB);
    expect(aExp).toHaveLength(1);
    expect(bExp).toHaveLength(0);
  });

  it("tenant A records a return; tenant B sees nothing", async () => {
    await recordReturn(tenantA, {
      saleId: saleA,
      productId: productA,
      returnedQuantity: 1,
      reason: "scratch",
    });
    const aReturns = await listReturns(tenantA);
    const bReturns = await listReturns(tenantB);
    expect(aReturns).toHaveLength(1);
    expect(bReturns).toHaveLength(0);
  });

  it("tenant B voiding tenant A's sale throws not-found (RLS hides the row)", async () => {
    await expect(voidSale(tenantB, saleA)).rejects.toThrow();
    // A's sale is unchanged
    const aSales = await listSales(tenantA);
    expect(aSales.find((s) => s.id === saleA)).toBeDefined();
  });

  it("raw select with no app.tenant_id returns 0 sales rows", async () => {
    const result = await db.transaction((tx) =>
      tx.execute(sql`select id from sales`),
    );
    expect((result as unknown as { length: number }).length).toBe(0);
  });
});

describe("collections isolation (0055)", () => {
  let accountA: string;
  let collectionA: string;
  beforeAll(async () => {
    await withTenant(tenantA, async (tx) => {
      const [acc] = await tx.insert(collectionAccounts).values({
        tenantId: tenantA, branchId: branchA, rail: "wallet", provider: "vodafone_cash",
        label: "VF A", walletMsisdn: "+201001234567", isPosDefault: true,
      }).returning({ id: collectionAccounts.id });
      accountA = acc!.id;
      const [col] = await tx.insert(collections).values({
        tenantId: tenantA, branchId: branchA, sourceType: "sale", invoiceId: "ISO-COL-1",
        method: "wallet", collectionAccountId: accountA, amount: "150.00", rungAt: new Date(),
        recordedByUserId: userA,
      }).returning({ id: collections.id });
      collectionA = col!.id;
      await tx.insert(collectionEvents).values({
        tenantId: tenantA, collectionId: collectionA, kind: "created", toStatus: "pending", actorUserId: userA,
      });
    });
  });

  it("tenant B sees none of A's accounts, collections or events", async () => {
    const [a, c, e] = await withTenant(tenantB, async (tx) => [
      await tx.select().from(collectionAccounts),
      await tx.select().from(collections),
      await tx.select().from(collectionEvents),
    ]);
    expect([a.length, c.length, e.length]).toEqual([0, 0, 0]);
  });

  it("tenant B cannot update or delete A's collection (row invisible → 0 rows)", async () => {
    const upd = await withTenant(tenantB, (tx) =>
      tx.update(collections).set({ status: "confirmed" }).where(eq(collections.id, collectionA)).returning(),
    );
    const del = await withTenant(tenantB, (tx) =>
      tx.delete(collectionAccounts).where(eq(collectionAccounts.id, accountA)).returning(),
    );
    expect([upd.length, del.length]).toEqual([0, 0]);
    const [still] = await withTenant(tenantA, (tx) =>
      tx.select({ status: collections.status }).from(collections).where(eq(collections.id, collectionA)),
    );
    expect(still?.status).toBe("pending");
  });

  it("tenant B cannot write a row carrying A's tenant_id (WITH CHECK → 42501)", async () => {
    const err = await pgFails(withTenant(tenantB, (tx) => tx.insert(collectionAccounts).values({
      tenantId: tenantA, rail: "instapay", provider: "cib", label: "x", accountLast4: "1234",
    })));
    expect(pgCode(err)).toBe("42501");
  });

  it("no app.tenant_id → 0 rows on all three tables", async () => {
    const n = await db.transaction(async (tx) =>
      (await tx.select().from(collections)).length +
      (await tx.select().from(collectionAccounts)).length +
      (await tx.select().from(collectionEvents)).length,
    );
    expect(n).toBe(0);
  });

  it("uniques are per tenant: the same wallet number is fine in B, a 2nd POS default in A is not", async () => {
    await withTenant(tenantB, (tx) => tx.insert(collectionAccounts).values({
      tenantId: tenantB, branchId: branchB, rail: "wallet", provider: "vodafone_cash",
      label: "VF B", walletMsisdn: "+201001234567",
    }));
    const err = await pgFails(withTenant(tenantA, (tx) => tx.insert(collectionAccounts).values({
      tenantId: tenantA, branchId: branchA, rail: "wallet", provider: "orange_cash",
      label: "OC A", walletMsisdn: "+201201234567", isPosDefault: true,
    })));
    expect(isUniqueViolation(err, "collection_accounts_pos_default_uq")).toBe(true);
  });

  it("a replayed part is absorbed by collections_sale_part_uq (ON CONFLICT … DO NOTHING)", async () => {
    const rows = await withTenant(tenantA, (tx) => tx.execute(sql`
      INSERT INTO collections (tenant_id, branch_id, source_type, invoice_id, method, collection_account_id, amount, rung_at)
      VALUES (${tenantA}, ${branchA}, 'sale', 'ISO-COL-1', 'wallet', ${accountA}, 150, now())
      ON CONFLICT (tenant_id, invoice_id, part_no) WHERE source_type = 'sale' DO NOTHING RETURNING id`));
    expect((rows as unknown as unknown[]).length).toBe(0);
  });
});
