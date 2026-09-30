/**
 * Doc 15 spec 13 §7 T3 — the `collections-tick` runner (M1 jobs: staleSweep,
 * limitSweep) against the real DB (withTenant + RLS), plus the route's 401.
 *
 * Every case builds its own tenant (owner + branches + shop_settings) and
 * inserts `collections` rows directly with a backdated `rung_at`; the tenants
 * are deleted in afterAll. Push delivery and the mailer are mocked; the
 * fanout, the notification rows and the collection_events rows are real.
 * Skipped unless DATABASE_URL names a `test` database (set all three URLs —
 * 04 §5 helper `T`).
 */
import { randomInt } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/push/notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/push/notify")>();
  return {
    ...actual,
    notifyUserDevices: vi.fn(async () => ({ status: "sent", outcomes: [], disabled: [] })),
  };
});
vi.mock("@/lib/mailer", () => ({ sendMail: vi.fn(async () => undefined) }));

import { db, withTenant } from "@/lib/db";
import {
  branches,
  collectionAccounts,
  collectionEvents,
  collections,
  notifications,
  shopSettings,
  tenantMembers,
  tenants,
  users,
} from "@/lib/db/schema";
import { cacheGet } from "@/lib/cache";
import { redis } from "@/lib/redis";
import {
  limitSweep,
  runCollectionsTick,
  staleSweep,
  TICK_CURSOR_KEY,
  type TickTenant,
} from "@/lib/repo/collections-tick";
import { POST as tickRoute } from "@/app/api/cron/collections-tick/route";

const url = process.env.DATABASE_URL ?? "";
const hasTestDb = /test/i.test(url);
const savedEnabled = process.env.COLLECTIONS_ENABLED;

const madeTenants: string[] = [];
const madeUsers: string[] = [];

interface Shop {
  tenantId: string;
  ownerId: string;
  /** name → branch id */
  branch: Record<string, string>;
  tick: TickTenant;
}

const tag = () => Math.random().toString(36).slice(2, 8);

/** A tenant with an owner and one branch per entry of `branchSpecs`. */
async function seedShop(branchSpecs: Array<{ name: string; enabled: boolean; staleAfter?: number }>): Promise<Shop> {
  const t8 = tag();
  const out = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email: `tick-owner-${t8}@iso.test`, name: "Tick Owner", passwordHash: "x" })
      .returning({ id: users.id });
    const [t] = await tx
      .insert(tenants)
      .values({ name: `Tick ${t8}`, slug: `tick-${t8}` })
      .returning({ id: tenants.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${t!.id}, true)`);
    await tx.insert(tenantMembers).values({ tenantId: t!.id, userId: u!.id, role: "owner" });
    const branch: Record<string, string> = {};
    let first = true;
    for (const b of branchSpecs) {
      const [row] = await tx
        .insert(branches)
        .values({ tenantId: t!.id, slug: `${b.name}-${t8}`, name: b.name, isPrimary: first })
        .returning({ id: branches.id });
      first = false;
      branch[b.name] = row!.id;
      await tx.insert(shopSettings).values({
        tenantId: t!.id,
        branchId: row!.id,
        shopName: b.name,
        collectionsEnabled: b.enabled,
        collectionsStaleAfterMinutes: b.staleAfter ?? 120,
      });
    }
    return { tenantId: t!.id, ownerId: u!.id, branch };
  });
  madeTenants.push(out.tenantId);
  madeUsers.push(out.ownerId);
  return {
    ...out,
    tick: { id: out.tenantId, timezone: "Africa/Cairo", suspendedAt: null, deletionScheduledAt: null, isDemo: false },
  };
}

async function addAccount(
  shop: Shop,
  a: { rail: "wallet" | "instapay"; label: string; provider?: string; msisdn?: string; ipa?: string },
): Promise<string> {
  return withTenant(shop.tenantId, async (tx) => {
    const [row] = await tx
      .insert(collectionAccounts)
      .values({
        tenantId: shop.tenantId,
        branchId: null,
        rail: a.rail,
        provider: a.provider ?? (a.rail === "wallet" ? "vodafone_cash" : "cib"),
        label: a.label,
        walletMsisdn: a.msisdn ?? null,
        ipaHandle: a.ipa ?? null,
      })
      .returning({ id: collectionAccounts.id });
    return row!.id;
  });
}

let inv = 0;
async function addCollection(
  shop: Shop,
  c: { branch: string; minutesAgo: number; amount?: string; status?: string; accountId?: string | null; method?: string },
): Promise<string> {
  inv += 1;
  return withTenant(shop.tenantId, async (tx) => {
    const [row] = await tx
      .insert(collections)
      .values({
        tenantId: shop.tenantId,
        branchId: shop.branch[c.branch]!,
        sourceType: "sale",
        invoiceId: `tick-inv-${inv}-${tag()}`,
        method: c.method ?? "wallet",
        collectionAccountId: c.accountId ?? null,
        amount: c.amount ?? "100.00",
        status: c.status ?? "pending",
        rungAt: new Date(Date.now() - c.minutesAgo * 60_000),
      })
      .returning({ id: collections.id });
    return row!.id;
  });
}

async function notifRows(shop: Shop, kind: string) {
  return withTenant(shop.tenantId, (tx) =>
    tx
      .select({ id: notifications.id, title: notifications.title, link: notifications.link, branchId: notifications.branchId })
      .from(notifications)
      .where(and(eq(notifications.tenantId, shop.tenantId), eq(notifications.kind, kind))),
  );
}

async function staleEvents(shop: Shop) {
  return withTenant(shop.tenantId, (tx) =>
    tx
      .select({ collectionId: collectionEvents.collectionId, kind: collectionEvents.kind, details: collectionEvents.details })
      .from(collectionEvents)
      .where(and(eq(collectionEvents.tenantId, shop.tenantId), eq(collectionEvents.kind, "stale_alerted"))),
  );
}

async function staleNotifiedAt(shop: Shop, id: string) {
  const [r] = await withTenant(shop.tenantId, (tx) =>
    tx.select({ at: collections.staleNotifiedAt }).from(collections).where(eq(collections.id, id)),
  );
  return r?.at ?? null;
}

const adminClient = hasTestDb ? postgres(url, { max: 1 }) : null;
const adminDb = adminClient ? drizzle(adminClient) : null;

beforeAll(() => {
  process.env.COLLECTIONS_ENABLED = "on";
});

beforeEach(() => {
  process.env.COLLECTIONS_ENABLED = "on";
});

afterAll(async () => {
  if (savedEnabled === undefined) delete process.env.COLLECTIONS_ENABLED;
  else process.env.COLLECTIONS_ENABLED = savedEnabled;
  if (adminDb) {
    if (madeTenants.length) await adminDb.delete(tenants).where(inArray(tenants.id, madeTenants));
    if (madeUsers.length) await adminDb.delete(users).where(inArray(users.id, madeUsers));
  }
  await adminClient?.end();
});

// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!hasTestDb)("staleSweep (13 §4.10, D13-1, acceptance 5)", () => {
  it("claims each item once across two runs; one grouped alert per branch; stale_alerted events written", async () => {
    const shop = await seedShop([{ name: "main", enabled: true }]);
    const ids = [
      await addCollection(shop, { branch: "main", minutesAgo: 150, amount: "100.00" }),
      await addCollection(shop, { branch: "main", minutesAgo: 200, amount: "250.50" }),
      await addCollection(shop, { branch: "main", minutesAgo: 300, amount: "49.50" }),
    ];
    const fresh = await addCollection(shop, { branch: "main", minutesAgo: 30 });

    const first = await staleSweep(shop.tick, new Date());
    expect(first).toEqual({ collections: 3, notifications: 1 });
    for (const id of ids) expect(await staleNotifiedAt(shop, id)).not.toBeNull();
    expect(await staleNotifiedAt(shop, fresh)).toBeNull();

    const n = await notifRows(shop, "collection_stale");
    expect(n).toHaveLength(1); // the owner, once, for 3 items
    expect(n[0]!.link).toBe("/collections?status=pending&stale=1");
    expect(n[0]!.branchId).toBe(shop.branch.main);
    expect(n[0]!.title).toMatch(/3/);

    const ev = await staleEvents(shop);
    expect(ev.map((e) => e.collectionId).sort()).toEqual([...ids].sort());
    expect(ev.every((e) => (e.details as { staleAfterMinutes?: number }).staleAfterMinutes === 120)).toBe(true);

    const second = await staleSweep(shop.tick, new Date());
    expect(second).toEqual({ collections: 0, notifications: 0 });
    expect(await notifRows(shop, "collection_stale")).toHaveLength(1);
    expect(await staleEvents(shop)).toHaveLength(3);
  });

  it("uses each branch's threshold (120 vs 240); a disabled branch never alerts; decided items are skipped", async () => {
    const shop = await seedShop([
      { name: "fast", enabled: true, staleAfter: 120 },
      { name: "slow", enabled: true, staleAfter: 240 },
      { name: "off", enabled: false },
    ]);
    const fastDue = await addCollection(shop, { branch: "fast", minutesAgo: 150 });
    const slowNotYet = await addCollection(shop, { branch: "slow", minutesAgo: 150 });
    const slowDue = await addCollection(shop, { branch: "slow", minutesAgo: 250 });
    const offOld = await addCollection(shop, { branch: "off", minutesAgo: 600 });
    const confirmedOld = await addCollection(shop, { branch: "fast", minutesAgo: 600, status: "confirmed" });
    const rejectedOld = await addCollection(shop, { branch: "fast", minutesAgo: 600, status: "rejected" });

    const r = await staleSweep(shop.tick, new Date());
    expect(r).toEqual({ collections: 2, notifications: 2 });
    expect(await staleNotifiedAt(shop, fastDue)).not.toBeNull();
    expect(await staleNotifiedAt(shop, slowDue)).not.toBeNull();
    for (const id of [slowNotYet, offOld, confirmedOld, rejectedOld]) expect(await staleNotifiedAt(shop, id)).toBeNull();

    const n = await notifRows(shop, "collection_stale");
    expect(n.map((x) => x.branchId).sort()).toEqual([shop.branch.fast, shop.branch.slow].sort());
    const ev = await staleEvents(shop);
    const slowEv = ev.find((e) => e.collectionId === slowDue)!;
    expect((slowEv.details as { staleAfterMinutes: number }).staleAfterMinutes).toBe(240);
  });
});

describe.skipIf(!hasTestDb)("limitSweep (13 §4.10, D13-3, acceptance 6)", () => {
  it("day_80 once per tenant-local day; a new day's period alerts again", async () => {
    const shop = await seedShop([{ name: "main", enabled: true }]);
    const acc = await addAccount(shop, { rail: "wallet", label: "VF counter", msisdn: `+2010${randomInt(10_000_000, 99_999_999)}` });
    await addCollection(shop, { branch: "main", minutesAgo: 0, amount: "30000.00", accountId: acc });
    await addCollection(shop, { branch: "main", minutesAgo: 0, amount: "18000.00", accountId: acc, status: "confirmed" });

    const first = await limitSweep(shop.tick, new Date());
    expect(first).toEqual({ accounts: 1, notifications: 1 });
    const n = await notifRows(shop, "collection_limit");
    expect(n).toHaveLength(1);
    expect(n[0]!.link).toBe(`/collections?tab=totals&account=${acc}&warning=day_80`);
    // ASCII mask, never the full number (Q18).
    expect(n[0]!.title).toMatch(/\*\*\*\d{4}/);

    expect(await limitSweep(shop.tick, new Date())).toEqual({ accounts: 1, notifications: 0 });

    // Move the alert into yesterday: the dedupe period is the tenant-local day.
    await withTenant(shop.tenantId, (tx) =>
      tx
        .update(notifications)
        .set({ createdAt: sql`now() - interval '2 days'` })
        .where(and(eq(notifications.tenantId, shop.tenantId), eq(notifications.kind, "collection_limit"))),
    );
    expect(await limitSweep(shop.tick, new Date())).toEqual({ accounts: 1, notifications: 1 });
  });

  it("month_80 once per month (with day_80 on the same day)", async () => {
    const shop = await seedShop([{ name: "main", enabled: true }]);
    const acc = await addAccount(shop, { rail: "wallet", label: "Orange", provider: "orange_cash", msisdn: `+2012${randomInt(10_000_000, 99_999_999)}` });
    await addCollection(shop, { branch: "main", minutesAgo: 0, amount: "160000.00", accountId: acc, status: "auto_confirmed" });

    expect(await limitSweep(shop.tick, new Date())).toEqual({ accounts: 1, notifications: 2 });
    const links = (await notifRows(shop, "collection_limit")).map((x) => x.link).sort();
    expect(links).toEqual([
      `/collections?tab=totals&account=${acc}&warning=day_80`,
      `/collections?tab=totals&account=${acc}&warning=month_80`,
    ]);
    // Backdate only by 2 days: day_80 re-arms (new day), month_80 stays
    // deduped unless the 2 days crossed a month start.
    await withTenant(shop.tenantId, (tx) =>
      tx
        .update(notifications)
        .set({ createdAt: sql`now() - interval '2 days'` })
        .where(and(eq(notifications.tenantId, shop.tenantId), eq(notifications.kind, "collection_limit"))),
    );
    const [{ crossed }] = (await db.execute(
      sql`select date_trunc('month', (now() at time zone 'Africa/Cairo')) > (now() - interval '2 days') at time zone 'Africa/Cairo' as crossed`,
    )) as unknown as Array<{ crossed: boolean }>;
    expect(await limitSweep(shop.tick, new Date())).toEqual({ accounts: 1, notifications: crossed ? 2 : 1 });
  });

  it("void and rejected parts do not count; InstaPay accounts never warn; a disabled tenant is skipped", async () => {
    const shop = await seedShop([{ name: "main", enabled: true }]);
    const wallet = await addAccount(shop, { rail: "wallet", label: "VF", msisdn: `+2011${randomInt(10_000_000, 99_999_999)}` });
    const ipa = await addAccount(shop, { rail: "instapay", label: "CIB", ipa: `shop${tag()}@instapay` });
    await addCollection(shop, { branch: "main", minutesAgo: 0, amount: "48000.00", accountId: wallet, status: "void" });
    await addCollection(shop, { branch: "main", minutesAgo: 0, amount: "48000.00", accountId: wallet, status: "rejected" });
    await addCollection(shop, { branch: "main", minutesAgo: 0, amount: "100.00", accountId: wallet });
    await addCollection(shop, { branch: "main", minutesAgo: 0, amount: "200000.00", accountId: ipa, method: "instapay" });

    expect(await limitSweep(shop.tick, new Date())).toEqual({ accounts: 1, notifications: 0 });
    expect(await notifRows(shop, "collection_limit")).toHaveLength(0);

    const off = await seedShop([{ name: "main", enabled: false }]);
    const offAcc = await addAccount(off, { rail: "wallet", label: "VF", msisdn: `+2010${randomInt(10_000_000, 99_999_999)}` });
    await addCollection(off, { branch: "main", minutesAgo: 0, amount: "50000.00", accountId: offAcc });
    expect(await limitSweep(off.tick, new Date())).toEqual({ accounts: 0, notifications: 0 });
  });
});

describe.skipIf(!hasTestDb)("runCollectionsTick (13 §4.10 runner)", () => {
  it("runs both sweeps for an admitted tenant and sums the counters", async () => {
    const shop = await seedShop([{ name: "main", enabled: true }]);
    await addCollection(shop, { branch: "main", minutesAgo: 200 });
    const r = await runCollectionsTick({ now: new Date(), tenantIds: [shop.tenantId] });
    expect(r.tenants).toEqual({ total: 1, processed: 1 });
    expect(r.truncated).toBe(false);
    expect(r.failures).toBe(0);
    expect(r.staleSweep).toEqual({ collections: 1, notifications: 1 });
    expect(r.limitSweep).toEqual({ accounts: 0, notifications: 0 });
    expect(typeof r.ms).toBe("number");
  });

  it("COLLECTIONS_ENABLED=off (or pilot without the tenant) → the sweeps do not run", async () => {
    const shop = await seedShop([{ name: "main", enabled: true }]);
    const id = await addCollection(shop, { branch: "main", minutesAgo: 200 });
    process.env.COLLECTIONS_ENABLED = "off";
    const off = await runCollectionsTick({ now: new Date(), tenantIds: [shop.tenantId] });
    expect(off.tenants.processed).toBe(1);
    expect(off.staleSweep).toEqual({ collections: 0, notifications: 0 });
    process.env.COLLECTIONS_ENABLED = "pilot";
    const pilot = await runCollectionsTick({ now: new Date(), tenantIds: [shop.tenantId] });
    expect(pilot.staleSweep.collections).toBe(0);
    expect(await staleNotifiedAt(shop, id)).toBeNull();
    process.env.COLLECTIONS_ENABLED = "on";
  });

  it("demo, suspended and to-be-deleted tenants get no alerts (D13-6)", async () => {
    const shop = await seedShop([{ name: "main", enabled: true }]);
    const id = await addCollection(shop, { branch: "main", minutesAgo: 200 });
    for (const set of [{ isDemo: true }, { suspendedAt: new Date() }, { deletionScheduledAt: new Date() }]) {
      await db.update(tenants).set({ isDemo: false, suspendedAt: null, deletionScheduledAt: null, ...set }).where(eq(tenants.id, shop.tenantId));
      const r = await runCollectionsTick({ now: new Date(), tenantIds: [shop.tenantId] });
      expect(r.staleSweep.collections).toBe(0);
    }
    expect(await staleNotifiedAt(shop, id)).toBeNull();
  });

  it("budget honoured: budgetMs 0 → truncated, nothing processed, cursor saved", async () => {
    const shop = await seedShop([{ name: "main", enabled: true }]);
    await addCollection(shop, { branch: "main", minutesAgo: 200 });
    const r = await runCollectionsTick({ now: new Date(), budgetMs: 0, tenantIds: [shop.tenantId] });
    expect(r.truncated).toBe(true);
    expect(r.tenants).toEqual({ total: 1, processed: 0 });
    expect(r.staleSweep.collections).toBe(0);
    if (redis) expect(await cacheGet<string>(TICK_CURSOR_KEY)).toBe(shop.tenantId);
  });

  it("a thrown job is counted in failures and the next job still runs", async () => {
    const shop = await seedShop([{ name: "main", enabled: true }]);
    const limitSpy = vi.fn(async () => ({ accounts: 2, notifications: 1 }));
    const r = await runCollectionsTick({
      now: new Date(),
      tenantIds: [shop.tenantId],
      jobs: {
        staleSweep: async () => {
          throw new Error("boom");
        },
        limitSweep: limitSpy,
      },
    });
    expect(r.failures).toBe(1);
    expect(limitSpy).toHaveBeenCalledTimes(1);
    expect(r.limitSweep).toEqual({ accounts: 2, notifications: 1 });
  });
});

describe("POST /api/cron/collections-tick", () => {
  it("answers 401 without the cron bearer", async () => {
    const ip = `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
    const req = new NextRequest("http://localhost/api/cron/collections-tick", {
      method: "POST",
      headers: { "x-real-ip": ip },
    });
    const res = await tickRoute(req);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});
