/**
 * Doc 16 §12 — sale alerts ("cha-ching" on every shop device), against the
 * real DB (withTenant + RLS). The Expo transport is an injected fetch double
 * (as push.test.ts does), the burst store is a fresh MemoryBurstStore per
 * test, the summary timer is captured through the `schedule` seam, and the
 * Redis publish to web tabs is spied.
 *
 * v2 fanout (owner's call, 2026-10-25):
 *   • permission filter removed — a stock clerk at the sale's branch rings too
 *   • origin exclusion removed — the recording device rings
 *   • branch filter kept    — a sale at branch 1 does NOT page branch 2 staff
 *
 * Seed: one tenant, two branches, and
 *   owner  (en)  tokens O1, O2
 *   S1     (ar)  branch 1, view_sales             token S1 (+ a disabled one)
 *   S2     (ar)  branch 1, no view_sales          token S2
 *   S3     (ar)  branch 2, view_sales             token S3
 *   SELLER (ar)  branch 1, view_sales, display "Ahmed Ali"   token SELL
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/notifications/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/events")>();
  return { ...actual, publishUserSaleAlert: vi.fn(async () => undefined) };
});

import { db, withTenant } from "@/lib/db";
import {
  branches,
  notificationPreferences,
  pushReceipts,
  pushTokens,
  tenantMembers,
  tenants,
  users,
} from "@/lib/db/schema";
import { publishUserSaleAlert } from "@/lib/notifications/events";
import {
  alertSale,
  MemoryBurstStore,
  SALE_ALERT_SUMMARY_DELAY_MS,
  settleSaleAlerts,
  type SaleAlertInput,
} from "@/lib/notifications/sale-alerts";
import type { ExpoTicket } from "@/lib/push/expo-push";

const publishMock = vi.mocked(publishUserSaleAlert);

// ─── Fake Expo ───────────────────────────────────────────────────────────────

type Wire = Record<string, unknown> & { to: string; title: string; body?: string; data?: Record<string, unknown> };

function fakeExpo(ticketFor: (m: Wire) => ExpoTicket = () => ({ status: "ok", id: `tk-${randomUUID()}` })) {
  const sent: Wire[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Wire[];
    sent.push(...body);
    return new Response(JSON.stringify({ data: body.map((m) => ticketFor(m)) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { sent, fetch: fetchImpl };
}

const tok = (name: string) => `ExponentPushToken[sa-${name}-${tag}]`;

// ─── Seed ────────────────────────────────────────────────────────────────────

const tag = Math.random().toString(36).slice(2, 8);
let tenantId: string;
let branch1: string;
let branch2: string;
const U: Record<"owner" | "S1" | "S2" | "S3" | "SELLER", string> = { owner: "", S1: "", S2: "", S3: "", SELLER: "" };

beforeAll(async () => {
  await db.transaction(async (tx) => {
    for (const k of Object.keys(U) as Array<keyof typeof U>) {
      const [u] = await tx
        .insert(users)
        .values({
          email: `salealert-${k.toLowerCase()}-${tag}@test.local`,
          name: k === "SELLER" ? "Ignored Name" : `User ${k}`,
          passwordHash: "x",
          locale: k === "owner" ? "en" : "ar",
        })
        .returning({ id: users.id });
      U[k] = u!.id;
    }
    const [t] = await tx
      .insert(tenants)
      .values({ name: `Sale Alert Shop ${tag}`, slug: `salealert-${tag}`, timezone: "Africa/Cairo" })
      .returning({ id: tenants.id });
    tenantId = t!.id;
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    const [b1] = await tx
      .insert(branches)
      .values({ tenantId, slug: "main", name: "المعادي", isPrimary: true })
      .returning({ id: branches.id });
    const [b2] = await tx
      .insert(branches)
      .values({ tenantId, slug: `second-${tag}`, name: "Second" })
      .returning({ id: branches.id });
    branch1 = b1!.id;
    branch2 = b2!.id;
    await tx.insert(tenantMembers).values([
      { tenantId, userId: U.owner, role: "owner" },
      { tenantId, userId: U.S1, role: "staff", branchId: branch1, permissions: ["record_sales", "view_sales"] },
      { tenantId, userId: U.S2, role: "staff", branchId: branch1, permissions: ["record_sales"] },
      { tenantId, userId: U.S3, role: "staff", branchId: branch2, permissions: ["record_sales", "view_sales"] },
      {
        tenantId,
        userId: U.SELLER,
        role: "staff",
        branchId: branch1,
        permissions: ["record_sales", "view_sales"],
        displayName: "Ahmed Ali",
      },
    ]);
  });
});

async function seedTokens() {
  await withTenant(tenantId, async (tx) => {
    await tx.insert(pushTokens).values([
      { tenantId, userId: U.owner, expoToken: tok("o1"), platform: "ios" },
      { tenantId, userId: U.owner, expoToken: tok("o2"), platform: "android" },
      { tenantId, userId: U.S1, expoToken: tok("s1"), platform: "android" },
      { tenantId, userId: U.S1, expoToken: tok("s1dead"), platform: "android", disabledAt: new Date() },
      { tenantId, userId: U.S2, expoToken: tok("s2"), platform: "android" },
      { tenantId, userId: U.S3, expoToken: tok("s3"), platform: "android" },
      { tenantId, userId: U.SELLER, expoToken: tok("sell"), platform: "ios" },
    ]);
  });
}

const adminClient = postgres(process.env.DATABASE_URL!, { max: 1 });
const adminDb = drizzle(adminClient);

afterAll(async () => {
  if (tenantId) await adminDb.delete(tenants).where(eq(tenants.id, tenantId));
  await adminDb.delete(users).where(inArray(users.id, Object.values(U).filter(Boolean)));
  await adminClient.end();
});

afterEach(async () => {
  publishMock.mockClear();
  delete process.env.SALE_ALERTS_DISABLED;
  await withTenant(tenantId, async (tx) => {
    await tx.delete(pushReceipts).where(eq(pushReceipts.tenantId, tenantId));
    await tx.delete(pushTokens).where(eq(pushTokens.tenantId, tenantId));
    await tx.delete(notificationPreferences).where(eq(notificationPreferences.tenantId, tenantId));
  });
});

const NOW = Date.UTC(2026, 9, 19, 12, 32, 0);

function sale(over: Partial<SaleAlertInput> = {}): SaleAlertInput {
  return {
    tenantId,
    branchId: branch1,
    branchName: "المعادي",
    saleId: randomUUID(),
    invoiceId: "INV-8K2Q",
    total: 2700,
    itemCount: 3,
    paymentMethod: "instapay",
    sellerUserId: U.SELLER,
    saleDate: new Date(NOW),
    firstProductName: "Casio MTP-1374L",
    lineCount: 1,
    origin: tok("sell"),
    outboxReplay: false,
    ...over,
  };
}

const byTo = (sent: Wire[]) => new Map(sent.map((m) => [m.to, m]));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("recipients and devices (doc 16 §2)", () => {
  it("owner + ALL same-branch staff ring (incl. no-view_sales + the recording device); other-branch staff and dead tokens do not", async () => {
    await seedTokens();
    const expo = fakeExpo();
    await alertSale(sale(), { fetch: expo.fetch, store: new MemoryBurstStore(), now: () => NOW });

    const to = expo.sent.map((m) => m.to).sort();
    // v2 (2026-10-25): S2 (no view_sales) and the seller's own device BOTH ring.
    expect(to).toEqual([tok("o1"), tok("o2"), tok("s1"), tok("s2"), tok("sell")].sort());
    expect(to).toContain(tok("s2"));
    expect(to).toContain(tok("sell"));
    // Still excluded: branch-2 staff and tokens we have explicitly disabled.
    expect(to).not.toContain(tok("s3"));
    expect(to).not.toContain(tok("s1dead"));
  });

  it("every live token for every eligible user rings, regardless of which one was the origin", async () => {
    await seedTokens();
    await withTenant(tenantId, (tx) =>
      tx.insert(pushTokens).values({ tenantId, userId: U.SELLER, expoToken: tok("sell2"), platform: "android" }),
    );
    const expo = fakeExpo();
    await alertSale(sale(), { fetch: expo.fetch, store: new MemoryBurstStore(), now: () => NOW });
    const to = expo.sent.map((m) => m.to);
    // v2: BOTH seller phones ring — the recording one AND the second one.
    expect(to).toContain(tok("sell2"));
    expect(to).toContain(tok("sell"));
  });

  it("origin header is ignored for token selection (v2); both of a user's tokens receive", async () => {
    await seedTokens();
    const expo = fakeExpo();
    await alertSale(sale({ origin: tok("o1"), sellerUserId: U.owner }), {
      fetch: expo.fetch,
      store: new MemoryBurstStore(),
      now: () => NOW,
    });
    const to = expo.sent.map((m) => m.to);
    expect(to).toContain(tok("o1"));
    expect(to).toContain(tok("o2"));
    expect(to).toContain(tok("sell"));
  });

  it("a stored push=false mutes that user only", async () => {
    await seedTokens();
    await withTenant(tenantId, (tx) =>
      tx.insert(notificationPreferences).values({
        tenantId,
        userId: U.owner,
        eventType: "sale.alert",
        inApp: false,
        push: false,
        email: false,
        digestMode: "instant",
      }),
    );
    const expo = fakeExpo();
    await alertSale(sale(), { fetch: expo.fetch, store: new MemoryBurstStore(), now: () => NOW });
    expect(expo.sent.map((m) => m.to)).toEqual([tok("s1")]);
    // Muted users get no web toast either.
    expect(publishMock.mock.calls.map((c) => c[0])).not.toContain(U.owner);
  });

  it("branch 2 sale → the owner and S3 only", async () => {
    await seedTokens();
    const expo = fakeExpo();
    await alertSale(sale({ branchId: branch2, branchName: "Second", origin: null }), {
      fetch: expo.fetch,
      store: new MemoryBurstStore(),
      now: () => NOW,
    });
    expect(expo.sent.map((m) => m.to).sort()).toEqual([tok("o1"), tok("o2"), tok("s3")].sort());
  });
});

describe("wire shape and copy (doc 16 §3-4)", () => {
  it("sound cha_ching.wav, channel sales, ttl 900, the deep-link data", async () => {
    await seedTokens();
    const expo = fakeExpo();
    const s = sale();
    await alertSale(s, { fetch: expo.fetch, store: new MemoryBurstStore(), now: () => NOW });
    const m = byTo(expo.sent).get(tok("o1"))!;
    expect(m).toMatchObject({ sound: "cha_ching.wav", channelId: "sales", ttl: 900, priority: "high" });
    expect(m.data).toEqual({
      type: "sale_alert",
      route: `/sales/${s.saleId}`,
      id: s.saleId,
      link: "/sales",
      tenantId,
      branchId: branch1,
      invoiceId: "INV-8K2Q",
    });
  });

  it("renders each recipient's language: en for the owner, ar for staff; never the customer", async () => {
    await seedTokens();
    const expo = fakeExpo();
    await alertSale(sale(), { fetch: expo.fetch, store: new MemoryBurstStore(), now: () => NOW });
    const m = byTo(expo.sent);
    expect(m.get(tok("o1"))).toMatchObject({
      title: "New sale · EGP 2,700",
      body: "Casio MTP-1374L · InstaPay · by Ahmed · المعادي",
    });
    expect(m.get(tok("s1"))).toMatchObject({
      title: "بيع جديد · 2,700 ج.م",
      // The seller's display name is used as typed (first word only).
      body: "Casio MTP-1374L · إنستاباي · سجّلها Ahmed · فرع المعادي",
    });
    for (const w of expo.sent) {
      expect(JSON.stringify(w)).not.toMatch(/customer|01\d{9}/i);
    }
  });

  it("cash omits the payment part; one item, no seller, no product → the body carries only the branch", async () => {
    await seedTokens();
    const expo = fakeExpo();
    await alertSale(
      sale({ paymentMethod: "cash", itemCount: 1, sellerUserId: null, origin: null, firstProductName: null }),
      { fetch: expo.fetch, store: new MemoryBurstStore(), now: () => NOW },
    );
    const m = byTo(expo.sent);
    expect(m.get(tok("o1"))!.body).toBe("المعادي");
    expect(m.get(tok("s1"))!.body).toBe("فرع المعادي");
  });

  it("wallet / card / deferred labels", async () => {
    await seedTokens();
    for (const [method, en, ar] of [
      ["wallet", "Mobile wallet", "محفظة موبايل"],
      ["card", "Card", "فيزا"],
      ["deferred", "On credit", "آجل"],
    ] as const) {
      const expo = fakeExpo();
      await alertSale(sale({ paymentMethod: method }), { fetch: expo.fetch, store: new MemoryBurstStore(), now: () => NOW });
      const m = byTo(expo.sent);
      expect(m.get(tok("o1"))!.body).toContain(` · ${en} · `);
      expect(m.get(tok("s1"))!.body).toContain(` · ${ar} · `);
    }
  });

  it("the offline suffix appears only for an outbox replay older than 60 s, in the tenant's time zone", async () => {
    await seedTokens();
    const rungAt = new Date(NOW - 10 * 60_000); // 12:22 UTC
    const expo = fakeExpo();
    await alertSale(sale({ outboxReplay: true, saleDate: rungAt }), {
      fetch: expo.fetch,
      store: new MemoryBurstStore(),
      now: () => NOW,
    });
    const m = byTo(expo.sent);
    const cairo = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Africa/Cairo",
    })
      .format(rungAt)
      .replace(/\s+/g, " ");
    expect(m.get(tok("o1"))!.body).toMatch(new RegExp(` · recorded offline at ${cairo}$`));
    expect(m.get(tok("s1"))!.body).toMatch(/ · اتسجّلت أوفلاين الساعة \d{1,2}:\d{2} [صم]$/);

    // A fresh replay (≤ 60 s) and a non-replay carry no suffix.
    const fresh = fakeExpo();
    await alertSale(sale({ outboxReplay: true, saleDate: new Date(NOW - 30_000) }), {
      fetch: fresh.fetch,
      store: new MemoryBurstStore(),
      now: () => NOW,
    });
    expect(byTo(fresh.sent).get(tok("o1"))!.body).not.toMatch(/offline/);
    const live = fakeExpo();
    await alertSale(sale({ saleDate: rungAt }), { fetch: live.fetch, store: new MemoryBurstStore(), now: () => NOW });
    expect(byTo(live.sent).get(tok("o1"))!.body).not.toMatch(/offline/);
  });

  it("a back-dated (> 24 h) non-replay sale sends nothing; the same date as an outbox replay rings", async () => {
    await seedTokens();
    const old = new Date(NOW - 2 * 86_400_000);
    const expo = fakeExpo();
    await alertSale(sale({ saleDate: old }), { fetch: expo.fetch, store: new MemoryBurstStore(), now: () => NOW });
    expect(expo.sent).toHaveLength(0);
    expect(publishMock).not.toHaveBeenCalled();

    await alertSale(sale({ saleDate: old, outboxReplay: true }), {
      fetch: expo.fetch,
      store: new MemoryBurstStore(),
      now: () => NOW,
    });
    expect(expo.sent.length).toBeGreaterThan(0);
  });

  it("SALE_ALERTS_DISABLED=1 sends nothing", async () => {
    await seedTokens();
    process.env.SALE_ALERTS_DISABLED = "1";
    const expo = fakeExpo();
    await alertSale(sale(), { fetch: expo.fetch, store: new MemoryBurstStore(), now: () => NOW });
    expect(expo.sent).toHaveLength(0);
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe("outcomes (doc 16 §8.7)", () => {
  it("a DeviceNotRegistered ticket disables only that token; ok tickets are queued for receipts", async () => {
    await seedTokens();
    const expo = fakeExpo((m) =>
      m.to === tok("o2")
        ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
        : { status: "ok", id: `tk-${m.to}` },
    );
    await alertSale(sale(), { fetch: expo.fetch, store: new MemoryBurstStore(), now: () => NOW });
    const rows = await withTenant(tenantId, (tx) =>
      tx.select({ token: pushTokens.expoToken, disabledAt: pushTokens.disabledAt }).from(pushTokens),
    );
    const state = new Map(rows.map((r) => [r.token, r.disabledAt]));
    expect(state.get(tok("o2"))).toBeInstanceOf(Date);
    expect(state.get(tok("o1"))).toBeNull();
    expect(state.get(tok("s1"))).toBeNull();
    const receipts = await withTenant(tenantId, (tx) =>
      tx.select({ userId: pushReceipts.userId, token: pushReceipts.expoToken }).from(pushReceipts),
    );
    // v2 fanout: S2 and SELL also receive now; o2 was marked DeviceNotRegistered so it's absent.
    expect(receipts.map((r) => r.token).sort()).toEqual(
      [tok("o1"), tok("s1"), tok("s2"), tok("sell")].sort(),
    );
    expect(receipts.find((r) => r.token === tok("s1"))!.userId).toBe(U.S1);
  });
});

describe("web tabs (doc 16 §6)", () => {
  it("publishes once per opted-in recipient — phones or not — and never forwards an Expo token", async () => {
    // No tokens at all: tabs still hear about it.
    const expo = fakeExpo();
    const s = sale();
    await alertSale(s, { fetch: expo.fetch, store: new MemoryBurstStore(), now: () => NOW });
    expect(expo.sent).toHaveLength(0);
    // v2: S2 (no view_sales) also receives the web toast now.
    expect(publishMock.mock.calls.map((c) => c[0]).sort()).toEqual(
      [U.owner, U.S1, U.S2, U.SELLER].sort(),
    );
    for (const [, payload] of publishMock.mock.calls) {
      expect(payload).toMatchObject({ id: s.saleId, link: "/sales", origin: null });
      expect(JSON.stringify(payload)).not.toMatch(/PushToken/);
    }
    const owner = publishMock.mock.calls.find((c) => c[0] === U.owner)![1];
    expect(owner.title).toBe("New sale · EGP 2,700");
  });

  it("forwards a web: origin so the recording tab stays quiet", async () => {
    const origin = `web:${randomUUID()}`;
    await alertSale(sale({ origin }), { fetch: fakeExpo().fetch, store: new MemoryBurstStore(), now: () => NOW });
    expect(publishMock.mock.calls.length).toBeGreaterThan(0);
    for (const [, payload] of publishMock.mock.calls) expect(payload.origin).toBe(origin);
  });
});

describe("burst rule (doc 16 §3)", () => {
  it("5 sales in 60 s → 3 single pushes, then one summary 30 s later with the count and sum of the rest", async () => {
    await seedTokens();
    const expo = fakeExpo();
    const store = new MemoryBurstStore();
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const schedule = (fn: () => void, ms: number) => void scheduled.push({ fn, ms });
    const totals = [100, 200, 300, 1000, 2400];
    for (let i = 0; i < totals.length; i++) {
      await alertSale(sale({ total: totals[i]!, origin: null }), {
        fetch: expo.fetch,
        store,
        now: () => NOW + i * 5_000,
        schedule,
      });
    }
    const singles = expo.sent.filter((m) => m.data?.type === "sale_alert");
    // v2: 3 sales × 5 devices (O1, O2, S1, S2, SELL) — S2 added now that
    // view_sales is no longer required.
    expect(singles).toHaveLength(15);
    expect(new Set(singles.map((m) => m.data!.id)).size).toBe(3);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(SALE_ALERT_SUMMARY_DELAY_MS);

    publishMock.mockClear();
    scheduled[0]!.fn();
    await settleSaleAlerts();
    const summaries = expo.sent.filter((m) => m.data?.type === "sale_alert_summary");
    expect(summaries.map((m) => m.to).sort()).toEqual(
      [tok("o1"), tok("o2"), tok("s1"), tok("s2"), tok("sell")].sort(),
    );
    const o1 = summaries.find((m) => m.to === tok("o1"))!;
    expect(o1).toMatchObject({
      title: "2 new sales · EGP 3,400",
      body: "In the last minute · المعادي",
      sound: "cha_ching.wav",
      channelId: "sales",
      ttl: 900,
    });
    expect(o1.data).toMatchObject({ type: "sale_alert_summary", route: "/sales/history", id: null, link: "/sales" });
    expect(summaries.find((m) => m.to === tok("s1"))!).toMatchObject({
      title: "بيعتين جداد · 3,400 ج.م",
      body: "في آخر دقيقة · فرع المعادي",
    });
    // Web tabs get the summary too, with a summary id and no origin.
    expect(publishMock.mock.calls).toHaveLength(3);
    for (const [, p] of publishMock.mock.calls) {
      expect(p.id).toMatch(/^summary:\d+$/);
      expect(p.origin).toBeNull();
    }

    // The claim was released: the next burst sale schedules a fresh flush.
    await alertSale(sale({ origin: null }), { fetch: expo.fetch, store, now: () => NOW + 30_000, schedule });
    expect(scheduled).toHaveLength(2);
  });

  it("the window slides: a sale more than 60 s after the others rings individually", async () => {
    await seedTokens();
    const expo = fakeExpo();
    const store = new MemoryBurstStore();
    const schedule = vi.fn();
    for (let i = 0; i < 3; i++) {
      await alertSale(sale({ origin: null }), { fetch: expo.fetch, store, now: () => NOW + i * 1000, schedule });
    }
    await alertSale(sale({ origin: null }), { fetch: expo.fetch, store, now: () => NOW + 70_000, schedule });
    expect(schedule).not.toHaveBeenCalled();
    expect(new Set(expo.sent.map((m) => m.data!.id)).size).toBe(4);
  });
});
