/**
 * Doc 15 spec 13 §7 T3 — the `collections-tick` runner against the real DB
 * (withTenant + RLS), plus the route's 401. M1 jobs: staleSweep, limitSweep.
 * M2 jobs (13-C): silentSourceSweep, rawPurge, lateRematch, and limitSweep's
 * unmatched/held credit sums.
 *
 * Every case builds its own tenant (owner + branches + shop_settings) and
 * inserts `collections` rows directly with a backdated `rung_at`; the tenants
 * are deleted in afterAll. Push delivery and the mailer are mocked; the
 * fanout, the notification rows and the collection_events rows are real.
 * Skipped unless DATABASE_URL names a `test` database (set all three URLs —
 * 04 §5 helper `T`).
 */
import { randomBytes, randomInt } from "node:crypto";
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
  collectionCredits,
  collectionEvents,
  collectionIngestDevices,
  collectionRawMessages,
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
  lateRematch,
  limitSweep,
  rawPurge,
  runCollectionsTick,
  silentSourceSweep,
  staleSweep,
  TICK_CURSOR_KEY,
  type TickTenant,
} from "@/lib/repo/collections-tick";
import { POST as tickRoute } from "@/app/api/cron/collections-tick/route";
import { touchDeviceAfterBatch } from "@/lib/repo/collection-devices";
import { ingestMessages } from "@/lib/repo/collection-ingest";
import type { IngestDeviceContext } from "@/lib/api/ingest-token";
import { creditRow, device, msg, q, setupL2Tenant, vf1, walletAccount } from "./helpers/collections-l2-fixture";

const url = process.env.DATABASE_URL ?? "";
const hasTestDb = /test/i.test(url);
const savedEnabled = process.env.COLLECTIONS_ENABLED;
const savedIngest = process.env.COLLECTIONS_INGEST_ENABLED;
const savedIngestPilot = process.env.COLLECTIONS_INGEST_PILOT_TENANT_IDS;

function restoreEnv(k: string, v: string | undefined) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

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

/** An ingest device inserted directly (the table has no RLS), with its clock
 *  fields backdated so the 30-min grace and the 10-min "after last message"
 *  rule can be exercised without waiting. */
async function addDevice(
  shop: Shop,
  d: {
    platform?: "ios_shortcut" | "android_listener";
    branch?: string | null;
    accountIds?: string[];
    label?: string;
    createdMinutesAgo?: number;
    lastMessageMinutesAgo?: number | null;
    heartbeat?: Record<string, unknown> | null;
    revoked?: boolean;
  } = {},
): Promise<string> {
  const platform = d.platform ?? "ios_shortcut";
  const ago = (min: number) => new Date(Date.now() - min * 60_000);
  const [row] = await db
    .insert(collectionIngestDevices)
    .values({
      tenantId: shop.tenantId,
      branchId: d.branch ? shop.branch[d.branch]! : null,
      createdByUserId: shop.ownerId,
      label: d.label ?? `Phone ${tag()}`,
      platform,
      channels: platform === "android_listener" ? ["android_notification"] : ["ios_sms"],
      accountIds: d.accountIds ?? [],
      tokenHash: randomBytes(32).toString("hex"),
      tokenPrefix: randomBytes(4).toString("hex"),
      consentVersion: "2026-10-01",
      consentAt: ago(d.createdMinutesAgo ?? 240),
      lastMessageAt: d.lastMessageMinutesAgo == null ? null : ago(d.lastMessageMinutesAgo),
      lastHeartbeat: d.heartbeat ?? null,
      revokedAt: d.revoked ? new Date() : null,
      revokedReason: d.revoked ? "owner" : null,
      createdAt: ago(d.createdMinutesAgo ?? 240),
    })
    .returning({ id: collectionIngestDevices.id });
  return row!.id;
}

async function silentAlertedAt(shop: Shop, deviceId: string) {
  const [r] = await db
    .select({ at: collectionIngestDevices.silentAlertedAt })
    .from(collectionIngestDevices)
    .where(and(eq(collectionIngestDevices.tenantId, shop.tenantId), eq(collectionIngestDevices.id, deviceId)));
  return r?.at ?? null;
}

let dk = 0;
/** A credit row inserted directly (limitSweep's M2 sums). */
async function addCredit(
  shop: Shop,
  c: { accountId: string; amount: string; state: string; holdReason?: string | null; direction?: string; isTest?: boolean },
) {
  dk += 1;
  const [row] = await withTenant(shop.tenantId, (tx) =>
    tx.insert(collectionCredits).values({
      tenantId: shop.tenantId,
      collectionAccountId: c.accountId,
      direction: c.direction ?? "credit",
      channels: ["ios_sms"],
      templateId: "vodafone_cash.sms.credit.v1",
      amount: c.amount,
      senderKind: "alphanumeric",
      occurredAt: new Date(),
      deviceReceivedAt: new Date(),
      state: c.state,
      holdReason: c.holdReason ?? null,
      dedupeKey: `f:tick-${dk}-${tag()}`,
      isTest: c.isTest ?? false,
    }).returning({ id: collectionCredits.id }),
  );
  return row!.id;
}

/** A raw row inserted directly (rawPurge), expired `expiredMinutesAgo` ago (negative = still live). */
async function addRaw(shop: Shop, expiredMinutesAgo: number): Promise<string> {
  const [row] = await withTenant(shop.tenantId, (tx) =>
    tx
      .insert(collectionRawMessages)
      .values({
        tenantId: shop.tenantId,
        channel: "ios_sms",
        sender: "VF-Cash",
        senderKind: "alphanumeric",
        bodySha256: randomBytes(32).toString("hex"),
        titleEnc: null,
        bodyEnc: null,
        parseStatus: "unknown_format",
        receivedAt: new Date(),
        expiresAt: new Date(Date.now() - expiredMinutesAgo * 60_000),
      })
      .returning({ id: collectionRawMessages.id }),
  );
  return row!.id;
}

async function rawExists(shop: Shop, id: string): Promise<boolean> {
  const r = await withTenant(shop.tenantId, (tx) =>
    tx.select({ id: collectionRawMessages.id }).from(collectionRawMessages).where(eq(collectionRawMessages.id, id)),
  );
  return r.length === 1;
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
  restoreEnv("COLLECTIONS_ENABLED", savedEnabled);
  restoreEnv("COLLECTIONS_INGEST_ENABLED", savedIngest);
  restoreEnv("COLLECTIONS_INGEST_PILOT_TENANT_IDS", savedIngestPilot);
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

// ─────────────────────────────────────────────────────────────────────────────
// M2 (13-C)
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!hasTestDb)("silentSourceSweep (M2, D13-4, acceptance 7)", () => {
  it("3 missed → one alert naming the device; a rerun → none; a fresh accepted batch re-arms without re-alerting old sales", async () => {
    const shop = await seedShop([{ name: "main", enabled: true }]);
    const acc = await addAccount(shop, { rail: "wallet", label: "VF", msisdn: `+2010${randomInt(10_000_000, 99_999_999)}` });
    const dev = await addDevice(shop, { label: "Counter iPhone", createdMinutesAgo: 300, lastMessageMinutesAgo: 180 });
    // Missed: rung > 10 min after the last message and > 30 min ago.
    await addCollection(shop, { branch: "main", minutesAgo: 60, accountId: acc });
    await addCollection(shop, { branch: "main", minutesAgo: 90, accountId: acc });
    await addCollection(shop, { branch: "main", minutesAgo: 120, accountId: acc, status: "confirmed" });
    // Not missed: too fresh (grace), within 10 min of the last message, decided, no account.
    await addCollection(shop, { branch: "main", minutesAgo: 5, accountId: acc });
    await addCollection(shop, { branch: "main", minutesAgo: 175, accountId: acc });
    await addCollection(shop, { branch: "main", minutesAgo: 60, accountId: acc, status: "rejected" });
    await addCollection(shop, { branch: "main", minutesAgo: 60, accountId: null });

    expect(await silentSourceSweep(shop.tick, new Date())).toEqual({ devices: 1, notifications: 1 });
    expect(await silentAlertedAt(shop, dev)).not.toBeNull();
    const n = await notifRows(shop, "collection_source_silent");
    expect(n).toHaveLength(1); // the owner
    expect(n[0]!.title).toContain("Counter iPhone");
    expect(n[0]!.link).toBe("/settings/collections");

    // Once per silence.
    expect(await silentSourceSweep(shop.tick, new Date())).toEqual({ devices: 0, notifications: 0 });

    // 07's contract: the next accepted batch sets last_message_at = now() and
    // clears silent_alerted_at — re-armed, and the old sales no longer count.
    await touchDeviceAfterBatch({ tenantId: shop.tenantId, deviceId: dev } as IngestDeviceContext, false);
    expect(await silentAlertedAt(shop, dev)).toBeNull();
    expect(await silentSourceSweep(shop.tick, new Date())).toEqual({ devices: 0, notifications: 0 });
    expect(await notifRows(shop, "collection_source_silent")).toHaveLength(1);
  });

  it("2 missed → none; the count is scoped to the device's accounts and branch", async () => {
    const shop = await seedShop([
      { name: "a", enabled: true },
      { name: "b", enabled: true },
    ]);
    const accA = await addAccount(shop, { rail: "wallet", label: "VF A", msisdn: `+2010${randomInt(10_000_000, 99_999_999)}` });
    const accB = await addAccount(shop, { rail: "wallet", label: "VF B", msisdn: `+2011${randomInt(10_000_000, 99_999_999)}` });
    const scoped = await addDevice(shop, { branch: "a", accountIds: [accA], lastMessageMinutesAgo: 200 });
    await addCollection(shop, { branch: "a", minutesAgo: 60, accountId: accA });
    await addCollection(shop, { branch: "a", minutesAgo: 70, accountId: accA });
    // Not missed: confirmed BY a forwarded credit (the phone did its job) — a third would alert.
    const matchedCredit = await addCredit(shop, { accountId: accA, amount: "100.00", state: "matched" });
    const matchedCol = await addCollection(shop, { branch: "a", minutesAgo: 65, accountId: accA, status: "confirmed" });
    await withTenant(shop.tenantId, (tx) =>
      tx.update(collections).set({ matchedCreditId: matchedCredit }).where(eq(collections.id, matchedCol)),
    );
    for (const m of [60, 70, 80]) await addCollection(shop, { branch: "a", minutesAgo: m, accountId: accB }); // other account
    for (const m of [60, 70, 80]) await addCollection(shop, { branch: "b", minutesAgo: m, accountId: accA }); // other branch

    expect(await silentSourceSweep(shop.tick, new Date())).toEqual({ devices: 0, notifications: 0 });
    expect(await silentAlertedAt(shop, scoped)).toBeNull();

    // Control: a device with no account list and no branch sees all 8 unmatched.
    const wide = await addDevice(shop, { lastMessageMinutesAgo: 200 });
    expect(await silentSourceSweep(shop.tick, new Date())).toEqual({ devices: 1, notifications: 1 });
    expect(await silentAlertedAt(shop, wide)).not.toBeNull();
    expect(await silentAlertedAt(shop, scoped)).toBeNull();
  });

  it("an Android listener reporting listenerConnected=false needs 1; connected needs 3; revoked and young devices are skipped", async () => {
    const shop = await seedShop([{ name: "main", enabled: true }]);
    const acc = await addAccount(shop, { rail: "wallet", label: "VF", msisdn: `+2010${randomInt(10_000_000, 99_999_999)}` });
    const off = await addDevice(shop, { platform: "android_listener", accountIds: [acc], heartbeat: { listenerConnected: false } });
    const on = await addDevice(shop, { platform: "android_listener", accountIds: [acc], heartbeat: { listenerConnected: true } });
    const revoked = await addDevice(shop, { accountIds: [acc], revoked: true });
    const young = await addDevice(shop, { accountIds: [acc], createdMinutesAgo: 10 });
    await addCollection(shop, { branch: "main", minutesAgo: 60, accountId: acc });

    expect(await silentSourceSweep(shop.tick, new Date())).toEqual({ devices: 1, notifications: 1 });
    expect(await silentAlertedAt(shop, off)).not.toBeNull();
    for (const id of [on, revoked, young]) expect(await silentAlertedAt(shop, id)).toBeNull();
  });
});

describe.skipIf(!hasTestDb)("rawPurge + the M2 gates in runCollectionsTick (Q14, SO-22)", () => {
  it("13 step 24 / SO-22: a SUSPENDED tenant with every flag off still has its expired raw rows purged", async () => {
    const shop = await seedShop([{ name: "main", enabled: false }]);
    const expired = await addRaw(shop, 1);
    const live = await addRaw(shop, -60 * 24);
    await db.update(tenants).set({ suspendedAt: new Date() }).where(eq(tenants.id, shop.tenantId));
    process.env.COLLECTIONS_ENABLED = "off";
    delete process.env.COLLECTIONS_INGEST_ENABLED;

    const r = await runCollectionsTick({ now: new Date(), tenantIds: [shop.tenantId] });
    expect(r.failures).toBe(0);
    expect(r.rawPurge).toEqual({ deleted: 1 });
    expect(await rawExists(shop, expired)).toBe(false);
    expect(await rawExists(shop, live)).toBe(true);
    expect(r.silentSourceSweep).toEqual({ devices: 0, notifications: 0 });
    expect(r.lateRematch).toEqual({ examined: 0, autoConfirmed: 0, suggested: 0 });

    // The job itself, directly: nothing left to delete.
    expect(await rawPurge(shop.tick)).toEqual({ deleted: 0 });
  });

  it("rawPurge runs for every tenant; silentSourceSweep + lateRematch only when COLLECTIONS_INGEST_ENABLED admits the tenant", async () => {
    const shop = await seedShop([{ name: "main", enabled: true }]);
    const spies = () => ({
      rawPurge: vi.fn(async () => ({ deleted: 2 })),
      silentSourceSweep: vi.fn(async () => ({ devices: 1, notifications: 1 })),
      lateRematch: vi.fn(async () => ({ examined: 3, autoConfirmed: 1, suggested: 1 })),
      staleSweep: vi.fn(async () => ({ collections: 0, notifications: 0 })),
      limitSweep: vi.fn(async () => ({ accounts: 0, notifications: 0 })),
    });
    const run = async (jobs: ReturnType<typeof spies>) =>
      runCollectionsTick({ now: new Date(), tenantIds: [shop.tenantId], jobs });

    // Suspended + COLLECTIONS_ENABLED off: only the purge.
    await db.update(tenants).set({ suspendedAt: new Date() }).where(eq(tenants.id, shop.tenantId));
    process.env.COLLECTIONS_ENABLED = "off";
    process.env.COLLECTIONS_INGEST_ENABLED = "on";
    let j = spies();
    let r = await run(j);
    expect(j.rawPurge).toHaveBeenCalledTimes(1);
    expect(j.staleSweep).not.toHaveBeenCalled();
    expect(j.silentSourceSweep).not.toHaveBeenCalled();
    expect(j.lateRematch).not.toHaveBeenCalled();
    expect(r.rawPurge).toEqual({ deleted: 2 });

    // Admitted for L1 but ingest off → no M2 alert jobs.
    await db.update(tenants).set({ suspendedAt: null }).where(eq(tenants.id, shop.tenantId));
    process.env.COLLECTIONS_ENABLED = "on";
    delete process.env.COLLECTIONS_INGEST_ENABLED;
    j = spies();
    await run(j);
    expect(j.rawPurge).toHaveBeenCalledTimes(1);
    expect(j.staleSweep).toHaveBeenCalledTimes(1);
    expect(j.silentSourceSweep).not.toHaveBeenCalled();
    expect(j.lateRematch).not.toHaveBeenCalled();

    // Ingest pilot with another tenant listed → still not admitted.
    process.env.COLLECTIONS_INGEST_ENABLED = "pilot";
    process.env.COLLECTIONS_INGEST_PILOT_TENANT_IDS = "00000000-0000-0000-0000-000000000000";
    j = spies();
    await run(j);
    expect(j.silentSourceSweep).not.toHaveBeenCalled();
    expect(j.lateRematch).not.toHaveBeenCalled();

    // Ingest pilot listing this tenant (its own list) → both run; counters summed.
    process.env.COLLECTIONS_INGEST_PILOT_TENANT_IDS = ` ${shop.tenantId.toUpperCase()} `;
    j = spies();
    r = await run(j);
    expect(j.silentSourceSweep).toHaveBeenCalledTimes(1);
    expect(j.lateRematch).toHaveBeenCalledTimes(1);
    expect(r.silentSourceSweep).toEqual({ devices: 1, notifications: 1 });
    expect(r.lateRematch).toEqual({ examined: 3, autoConfirmed: 1, suggested: 1 });
    expect(r.rawPurge).toEqual({ deleted: 2 });

    // Ingest admitted but a demo tenant → no alert jobs (D13-6); purge still runs.
    process.env.COLLECTIONS_INGEST_ENABLED = "on";
    await db.update(tenants).set({ isDemo: true }).where(eq(tenants.id, shop.tenantId));
    j = spies();
    await run(j);
    expect(j.rawPurge).toHaveBeenCalledTimes(1);
    expect(j.silentSourceSweep).not.toHaveBeenCalled();
    expect(j.lateRematch).not.toHaveBeenCalled();

    // A throwing purge is counted and the alert jobs still run.
    await db.update(tenants).set({ isDemo: false }).where(eq(tenants.id, shop.tenantId));
    j = spies();
    j.rawPurge.mockImplementationOnce(async () => {
      throw new Error("purge boom");
    });
    r = await run(j);
    expect(r.failures).toBe(1);
    expect(j.silentSourceSweep).toHaveBeenCalledTimes(1);
    delete process.env.COLLECTIONS_INGEST_PILOT_TENANT_IDS;
    delete process.env.COLLECTIONS_INGEST_ENABLED;
  });

  it("the real tick with ingest on reports the silent device in its JSON counters", async () => {
    const shop = await seedShop([{ name: "main", enabled: true }]);
    const acc = await addAccount(shop, { rail: "wallet", label: "VF", msisdn: `+2010${randomInt(10_000_000, 99_999_999)}` });
    const dev = await addDevice(shop, { accountIds: [acc], lastMessageMinutesAgo: 180 });
    for (const m of [40, 50, 60]) await addCollection(shop, { branch: "main", minutesAgo: m, accountId: acc });
    process.env.COLLECTIONS_INGEST_ENABLED = "on";
    const r = await runCollectionsTick({ now: new Date(), tenantIds: [shop.tenantId] });
    delete process.env.COLLECTIONS_INGEST_ENABLED;
    expect(r.failures).toBe(0);
    expect(r.silentSourceSweep).toEqual({ devices: 1, notifications: 1 });
    expect(r.lateRematch).toEqual({ examined: 0, autoConfirmed: 0, suggested: 0 });
    expect(await silentAlertedAt(shop, dev)).not.toBeNull();
  });
});

describe.skipIf(!hasTestDb)("lateRematch (M2, 07 rematchRecentCredits)", () => {
  it("a credit that arrived before its sale is re-matched by the tick (suggestion while auto-confirm is off)", async () => {
    process.env.COLLECTIONS_ENABLED = "on";
    process.env.COLLECTIONS_INGEST_ENABLED = "on";
    const f = await setupL2Tenant("tick-rematch");
    madeTenants.push(f.tenantId);
    const acc = await walletAccount(f);
    const phone = await device(f, { accountIds: [acc.id] });
    const out = await ingestMessages(phone.ctx, [msg(vf1({ amount: "150.00", receiving: acc.msisdn }))]);
    expect(out.results[0]!.status).toBe("accepted");
    const [cr] = await q<{ id: string; state: string }>(
      f,
      sql`SELECT id, state FROM collection_credits WHERE tenant_id = ${f.tenantId} AND direction = 'credit'`,
    );
    expect(cr!.state).toBe("unmatched");
    // 13 step 25: the unmatched copy end to end (07's fan-out is fire-and-forget).
    let unmatched: Array<{ title: string; link: string | null }> = [];
    for (let i = 0; i < 40 && unmatched.length === 0; i++) {
      unmatched = await q<{ title: string; link: string | null }>(
        f,
        sql`SELECT title, link FROM notifications WHERE tenant_id = ${f.tenantId} AND kind = 'collection_unmatched'`,
      );
      if (unmatched.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(unmatched.length).toBeGreaterThanOrEqual(1);
    expect(unmatched[0]!.title).toMatch(/150/);
    expect(unmatched[0]!.title).toContain(`VF ${acc.msisdn.slice(-4)}`);
    expect(unmatched[0]!.link).toBe("/collections?tab=credits");

    // The pending collection lands without 05's reverseMatch (the race lateRematch covers).
    const [col] = await withTenant(f.tenantId, (tx) =>
      tx
        .insert(collections)
        .values({
          tenantId: f.tenantId,
          branchId: f.branchId,
          sourceType: "sale",
          invoiceId: `tick-rematch-${tag()}`,
          method: "wallet",
          collectionAccountId: acc.id,
          amount: "150.00",
          status: "pending",
          rungAt: new Date(Date.now() - 2 * 60_000),
        })
        .returning({ id: collections.id }),
    );

    const tickT: TickTenant = { id: f.tenantId, timezone: "Africa/Cairo", suspendedAt: null, deletionScheduledAt: null, isDemo: false };
    const r = await lateRematch(tickT);
    expect(r.examined).toBe(1);
    expect(r.autoConfirmed + r.suggested).toBe(1);
    const after = await creditRow(f, cr!.id);
    expect(after.suggested_collection_id ?? after.matched_collection_id).toBe(col!.id);

    // Idempotent: the credit is no longer unmatched/ambiguous-with-a-new-suggestion.
    const again = await lateRematch(tickT);
    expect(again.autoConfirmed + again.suggested).toBe(0);
    delete process.env.COLLECTIONS_INGEST_ENABLED;
  });
});

describe.skipIf(!hasTestDb)("limitSweep M2 sums (13-C)", () => {
  it("unmatched and held credits count toward the day; matched, ignored, debit and test credits do not", async () => {
    const shop = await seedShop([{ name: "main", enabled: true }]);
    const acc = await addAccount(shop, { rail: "wallet", label: "VF", msisdn: `+2010${randomInt(10_000_000, 99_999_999)}` });
    await addCollection(shop, { branch: "main", minutesAgo: 0, amount: "30000.00", accountId: acc });
    await addCredit(shop, { accountId: acc, amount: "10000.00", state: "unmatched" });
    // Noise: each alone would push the day past 48,000 if it were counted.
    await addCredit(shop, { accountId: acc, amount: "50000.00", state: "matched" });
    await addCredit(shop, { accountId: acc, amount: "50000.00", state: "ignored" });
    await addCredit(shop, { accountId: acc, amount: "50000.00", state: "unmatched", direction: "debit" });
    await addCredit(shop, { accountId: acc, amount: "50000.00", state: "held", holdReason: "test", isTest: true });
    expect(await limitSweep(shop.tick, new Date())).toEqual({ accounts: 1, notifications: 0 });

    // 30,000 + 10,000 + 8,000 held = 48,000 = 80 % of the day limit.
    await addCredit(shop, { accountId: acc, amount: "8000.00", state: "held", holdReason: "ambiguous" });
    expect(await limitSweep(shop.tick, new Date())).toEqual({ accounts: 1, notifications: 1 });
    const n = await notifRows(shop, "collection_limit");
    expect(n.map((x) => x.link)).toEqual([`/collections?tab=totals&account=${acc}&warning=day_80`]);
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
