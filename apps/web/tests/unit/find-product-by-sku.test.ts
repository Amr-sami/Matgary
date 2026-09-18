/**
 * HANDOFF §8 #6 — findProductBySku against the real repo (live test DB, same
 * harness as tests/unit/oversell-repo.test.ts).
 *
 * The scanner lookup used to load the branch's whole catalogue and filter in
 * memory. Now it is one tenant-wide query with the web scanner's own
 * normalisation (`normalizeSku`) applied on both sides, and it answers WHICH
 * branch holds the code. The SQL half of that normalisation (lower + strip
 * regex + both UPC-A/EAN-13 spellings) is what only a database can prove.
 *
 * Needs DATABASE_URL to name a "test" database (skipped otherwise). Creates
 * its own tenant and never truncates.
 */
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db, withTenant } from "@/lib/db";
import { branches, categories, shopSettings, tenantMembers, tenants, users } from "@/lib/db/schema";
import { addProduct, findProductBySku } from "@/lib/repo/catalog";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";

const url = process.env.DATABASE_URL ?? "";
const hasTestDb = /test/i.test(url);

let tenantId: string;
let mainId: string;
let maadiId: string;
let categoryId: string;
const stamp = Math.random().toString(36).slice(2, 7);

async function product(branchId: string, sku: string, quantity: number) {
  const { id } = await addProduct(tenantId, branchId, {
    name: `Scan ${sku}`,
    categoryId,
    quantity,
    price: 10,
    lowStockThreshold: 0,
    sku,
  });
  return id;
}

beforeAll(async () => {
  if (!hasTestDb) return;
  const made = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email: `sku-${Date.now()}@iso.test`, name: "Sku", passwordHash: "x" })
      .returning({ id: users.id });
    const [t] = await tx
      .insert(tenants)
      .values({ name: "Sku", slug: `sku-${Math.random().toString(36).slice(2, 8)}` })
      .returning({ id: tenants.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    const [main] = await tx
      .insert(branches)
      .values({ tenantId: t.id, slug: "main", name: "مدينة نصر", isPrimary: true })
      .returning({ id: branches.id });
    const [maadi] = await tx
      .insert(branches)
      .values({ tenantId: t.id, slug: "maadi", name: "المعادي" })
      .returning({ id: branches.id });
    await tx.insert(tenantMembers).values({ tenantId: t.id, userId: u.id, role: "owner" });
    await tx.insert(shopSettings).values({ tenantId: t.id, branchId: main.id, shopName: "Sku" });
    await seedCornerStorePreset(tx, t.id, main.id);
    return { tenantId: t.id, mainId: main.id, maadiId: maadi.id };
  });
  tenantId = made.tenantId;
  mainId = made.mainId;
  maadiId = made.maadiId;
  const cats = await withTenant(tenantId, (tx) =>
    tx.select({ id: categories.id }).from(categories).where(eq(categories.tenantId, tenantId)).limit(1),
  );
  categoryId = cats[0]!.id;
});

describe.skipIf(!hasTestDb)("findProductBySku — tenant-wide, branch-attributed", () => {
  it("finds the code in a branch other than the caller's and says which", async () => {
    const sku = `ONLY-MAADI-${stamp}`;
    const id = await product(maadiId, sku, 5);
    const found = await findProductBySku(tenantId, sku);
    expect(found.map((f) => [f.product.id, f.branchId, f.branchName, f.product.quantity])).toEqual([
      [id, maadiId, "المعادي", 5],
    ]);
  });

  it("returns every branch that carries the code, in-stock rows first", async () => {
    const sku = `BOTH-${stamp}`;
    const empty = await product(mainId, sku, 0);
    const stocked = await product(maadiId, sku, 3);
    const found = await findProductBySku(tenantId, sku);
    expect(found.map((f) => f.product.id)).toEqual([stocked, empty]);
    expect(found.map((f) => f.branchId)).toEqual([maadiId, mainId]);
  });

  it("normalises like the web scanner: case, decoder junk, UPC-A ↔ EAN-13", async () => {
    const upper = await product(mainId, `AB-${stamp}`.toUpperCase(), 1);
    expect((await findProductBySku(tenantId, `ab-${stamp}`)).map((f) => f.product.id)).toEqual([upper]);
    // Zero-width space and a tab in the scanned value.
    expect(
      (await findProductBySku(tenantId, `AB-​${stamp}\t`)).map((f) => f.product.id),
    ).toEqual([upper]);

    // A 12-digit UPC-A stored, scanned as the 13-digit EAN-13 with a leading 0 — and back.
    const digits = `6${Date.now().toString().slice(-11)}`; // 12 digits
    const upc = await product(mainId, digits, 2);
    expect((await findProductBySku(tenantId, `0${digits}`)).map((f) => f.product.id)).toEqual([upc]);
    const ean = await product(maadiId, `0${digits}`, 4);
    const both = await findProductBySku(tenantId, digits);
    expect(new Set(both.map((f) => f.product.id))).toEqual(new Set([upc, ean]));
  });

  it("a stored sku with invisible characters is still found", async () => {
    const dirty = await product(mainId, `ZW-${stamp}‍`, 1);
    expect((await findProductBySku(tenantId, `zw-${stamp}`)).map((f) => f.product.id)).toEqual([dirty]);

    // Unicode spaces the JS `\s` strips but Postgres `[[:space:]]` does not:
    // a SKU pasted with an NBSP (U+00A0) or an ideographic space (U+3000).
    // The write path only trims ASCII space, so these reach the column.
    const nbsp = await product(mainId, `NB-\u00a0${stamp}`, 1);
    expect((await findProductBySku(tenantId, `nb-${stamp}`)).map((f) => f.product.id)).toEqual([nbsp]);
    const ideo = await product(maadiId, `ID-\u3000${stamp}`, 1);
    expect((await findProductBySku(tenantId, `id-${stamp}`)).map((f) => f.product.id)).toEqual([ideo]);
    // ...and the other way round: junk in the scanned value, clean in the column.
    const clean = await product(mainId, `UP-${stamp}`, 1);
    expect((await findProductBySku(tenantId, `\u202fup-${stamp}\u2009`)).map((f) => f.product.id)).toEqual([clean]);
  });

  it("an unknown or empty code is an empty result, not an error", async () => {
    expect(await findProductBySku(tenantId, `nope-${stamp}`)).toEqual([]);
    expect(await findProductBySku(tenantId, "   ")).toEqual([]);
  });

  it("never crosses the tenant boundary", async () => {
    const sku = `MINE-${stamp}`;
    await product(mainId, sku, 1);
    const [other] = await db
      .insert(tenants)
      .values({ name: "Other", slug: `oth-${Math.random().toString(36).slice(2, 8)}` })
      .returning({ id: tenants.id });
    expect(await findProductBySku(other!.id, sku)).toEqual([]);
  });
});
