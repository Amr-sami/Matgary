/**
 * Doc 15 spec 13 §7 T5 — `loadAwaitingCollections` (the dashboard
 * "awaiting confirmation" card, 13 §4.12, acceptance 12) against the real DB:
 * count / amount / stale with two branch thresholds, the branch filter, the
 * equality with the inbox's counts.pending, and the cache bust.
 * Skipped unless DATABASE_URL names a `test` database.
 */
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, withTenant } from "@/lib/db";
import { branches, collections, shopSettings, tenantMembers, tenants, users } from "@/lib/db/schema";
import { redis } from "@/lib/redis";
import { bustInsightsCache, loadAwaitingCollections } from "@/lib/repo/insights";
import { listCollections } from "@/lib/repo/collections";

const url = process.env.DATABASE_URL ?? "";
const hasTestDb = /test/i.test(url);
const saved = process.env.COLLECTIONS_ENABLED;

let tenantId = "";
let ownerId = "";
let fast = ""; // threshold 120
let slow = ""; // threshold 240

async function add(branchId: string, minutesAgo: number, amount: string, status = "pending") {
  await withTenant(tenantId, (tx) =>
    tx.insert(collections).values({
      tenantId,
      branchId,
      sourceType: "sale",
      invoiceId: `aw-${Math.random().toString(36).slice(2, 10)}`,
      method: "wallet",
      amount,
      status,
      rungAt: new Date(Date.now() - minutesAgo * 60_000),
    }),
  );
}

beforeAll(async () => {
  if (!hasTestDb) return;
  process.env.COLLECTIONS_ENABLED = "on";
  const t8 = Math.random().toString(36).slice(2, 8);
  await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email: `aw-owner-${t8}@iso.test`, name: "AW", passwordHash: "x" })
      .returning({ id: users.id });
    ownerId = u!.id;
    const [t] = await tx.insert(tenants).values({ name: `AW ${t8}`, slug: `aw-${t8}` }).returning({ id: tenants.id });
    tenantId = t!.id;
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.insert(tenantMembers).values({ tenantId, userId: ownerId, role: "owner" });
    const [b1] = await tx.insert(branches).values({ tenantId, slug: "fast", name: "Fast", isPrimary: true }).returning({ id: branches.id });
    const [b2] = await tx.insert(branches).values({ tenantId, slug: "slow", name: "Slow" }).returning({ id: branches.id });
    fast = b1!.id;
    slow = b2!.id;
    await tx.insert(shopSettings).values([
      { tenantId, branchId: fast, shopName: "Fast", collectionsEnabled: true, collectionsStaleAfterMinutes: 120 },
      { tenantId, branchId: slow, shopName: "Slow", collectionsEnabled: true, collectionsStaleAfterMinutes: 240 },
    ]);
  });
  // fast: 150 min (stale), 10 min (fresh), a confirmed one (never counted)
  await add(fast, 150, "100.00");
  await add(fast, 10, "50.25");
  await add(fast, 500, "999.00", "confirmed");
  // slow: 150 min (not stale at 240), 300 min (stale), a void one
  await add(slow, 150, "200.00");
  await add(slow, 300, "300.00");
  await add(slow, 600, "77.00", "void");
  await bustInsightsCache(tenantId);
});

afterAll(async () => {
  if (saved === undefined) delete process.env.COLLECTIONS_ENABLED;
  else process.env.COLLECTIONS_ENABLED = saved;
  if (!hasTestDb) return;
  const c = postgres(url, { max: 1 });
  const d = drizzle(c);
  if (tenantId) await d.delete(tenants).where(inArray(tenants.id, [tenantId]));
  if (ownerId) await d.delete(users).where(inArray(users.id, [ownerId]));
  await c.end();
});

describe.skipIf(!hasTestDb)("loadAwaitingCollections (13 §4.12)", () => {
  it("all branches: count, amount, stale per branch threshold, oldest", async () => {
    const r = await loadAwaitingCollections(tenantId, null);
    expect(r.count).toBe(4);
    expect(r.amount).toBe(650.25);
    expect(r.staleCount).toBe(2); // fast 150 (>120) + slow 300 (>240)
    expect(r.oldestRungAt).not.toBeNull();
    const ageMin = (Date.now() - new Date(r.oldestRungAt!).getTime()) / 60_000;
    expect(ageMin).toBeGreaterThan(299);
    expect(ageMin).toBeLessThan(302);
  });

  it("branch filter", async () => {
    expect(await loadAwaitingCollections(tenantId, fast)).toMatchObject({ count: 2, amount: 150.25, staleCount: 1 });
    expect(await loadAwaitingCollections(tenantId, slow)).toMatchObject({ count: 2, amount: 500, staleCount: 1 });
  });

  it("count equals the inbox's counts.pending for the same scope (acceptance 12)", async () => {
    for (const b of [fast, slow, null]) {
      const inbox = await listCollections(tenantId, { branchId: b, limit: 1 });
      const card = await loadAwaitingCollections(tenantId, b);
      expect(card.count).toBe(inbox.counts.pending);
      expect(card.staleCount).toBe(inbox.counts.stale);
    }
  });

  it("is cached 60 s and busted by bustInsightsCache", async () => {
    const before = await loadAwaitingCollections(tenantId, fast);
    await add(fast, 5, "10.00");
    const cached = await loadAwaitingCollections(tenantId, fast);
    if (redis) expect(cached.count).toBe(before.count);
    await bustInsightsCache(tenantId);
    const after = await loadAwaitingCollections(tenantId, fast);
    expect(after.count).toBe(before.count + 1);
    expect(after.amount).toBe(Math.round((before.amount + 10) * 100) / 100);
  });

  it("a tenant with nothing pending → zeros and a null oldest", async () => {
    const r = await withTenant(tenantId, async () => loadAwaitingCollections(tenantId, "00000000-0000-4000-8000-000000000000"));
    expect(r).toEqual({ count: 0, amount: 0, staleCount: 0, oldestRungAt: null });
  });
});
