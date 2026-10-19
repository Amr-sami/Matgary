/**
 * Doc 15 spec 13 §7 T2 — permission-aware recipients for the collection
 * events, against the real DB (withTenant + RLS).
 *
 * Seed: one tenant, two branches, the owner and four staff:
 *   A  branch 1, view_collections
 *   B  branch 1, no collection permission
 *   C  branch 2, view_collections
 *   D  branch 1, manage_collection_accounts
 *
 * Push delivery (`notifyUserDevices`) and the mailer are mocked; everything
 * else — the recipient query, the preference rows, the notification rows —
 * runs for real. Needs a DATABASE_URL whose database is migrated to 0055; it
 * creates its own tenant and deletes it in afterAll.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
  notificationPreferences,
  notifications,
  tenantMembers,
  tenants,
  users,
} from "@/lib/db/schema";
import { sendMail } from "@/lib/mailer";
import { fanoutEvent } from "@/lib/notifications/dispatch";
import { notifyUserDevices } from "@/lib/push/notify";
import { getNotificationPreferences, setNotificationPreference } from "@/lib/repo/notifications";

const notifyMock = vi.mocked(notifyUserDevices);
const mailMock = vi.mocked(sendMail);

const tag = Math.random().toString(36).slice(2, 8);
let tenantId: string;
let branch1: string;
let branch2: string;
const U: Record<"owner" | "A" | "B" | "C" | "D", string> = { owner: "", A: "", B: "", C: "", D: "" };
const prevEnabled = process.env.COLLECTIONS_ENABLED;

beforeAll(async () => {
  process.env.COLLECTIONS_ENABLED = "on";
  await db.transaction(async (tx) => {
    for (const k of Object.keys(U) as Array<keyof typeof U>) {
      const [u] = await tx
        .insert(users)
        .values({ email: `fanout-${k.toLowerCase()}-${tag}@test.local`, name: `User ${k}`, passwordHash: "x" })
        .returning({ id: users.id });
      U[k] = u!.id;
    }
    const [t] = await tx
      .insert(tenants)
      .values({ name: `Fanout Shop ${tag}`, slug: `fanout-${tag}` })
      .returning({ id: tenants.id });
    tenantId = t!.id;
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    const [b1] = await tx
      .insert(branches)
      .values({ tenantId, slug: "main", name: "Main", isPrimary: true })
      .returning({ id: branches.id });
    const [b2] = await tx
      .insert(branches)
      .values({ tenantId, slug: `second-${tag}`, name: "Second" })
      .returning({ id: branches.id });
    branch1 = b1!.id;
    branch2 = b2!.id;
    await tx.insert(tenantMembers).values([
      { tenantId, userId: U.owner, role: "owner" },
      { tenantId, userId: U.A, role: "staff", branchId: branch1, permissions: ["record_sales", "view_collections"] },
      { tenantId, userId: U.B, role: "staff", branchId: branch1, permissions: ["record_sales", "view_sales"] },
      { tenantId, userId: U.C, role: "staff", branchId: branch2, permissions: ["view_collections"] },
      { tenantId, userId: U.D, role: "staff", branchId: branch1, permissions: ["manage_collection_accounts"] },
    ]);
  });
});

// Cleanup through the owner connection (DATABASE_URL), as push.test.ts does:
// deleting the tenant cascades to branches, members, notifications and
// preferences.
const adminClient = postgres(process.env.DATABASE_URL!, { max: 1 });
const adminDb = drizzle(adminClient);

afterAll(async () => {
  if (prevEnabled === undefined) delete process.env.COLLECTIONS_ENABLED;
  else process.env.COLLECTIONS_ENABLED = prevEnabled;
  if (tenantId) await adminDb.delete(tenants).where(eq(tenants.id, tenantId));
  await adminDb.delete(users).where(inArray(users.id, Object.values(U).filter(Boolean)));
  await adminClient.end();
});

afterEach(async () => {
  notifyMock.mockClear();
  mailMock.mockClear();
  await withTenant(tenantId, async (tx) => {
    await tx.delete(notifications).where(eq(notifications.tenantId, tenantId));
    await tx.delete(notificationPreferences).where(eq(notificationPreferences.tenantId, tenantId));
  });
});

const nameOf = (id: string) => (Object.entries(U).find(([, v]) => v === id)?.[0] ?? id) as string;

async function rows() {
  const r = await withTenant(tenantId, (tx) =>
    tx
      .select({ userId: notifications.userId, kind: notifications.kind, link: notifications.link, branchId: notifications.branchId })
      .from(notifications)
      .where(eq(notifications.tenantId, tenantId)),
  );
  return r.map((x) => ({ ...x, who: nameOf(x.userId) })).sort((a, b) => a.who.localeCompare(b.who));
}

const pushedTo = () =>
  notifyMock.mock.calls.map((c) => nameOf(c[1] as string)).sort();

describe("collection fanout recipients (13 §4.4)", () => {
  it("stale on branch 1 → the owner + A (view_collections, same branch); the default link; both pushed", async () => {
    await fanoutEvent(tenantId, branch1, "collection.stale", {
      branchName: "Main",
      count: 3,
      amountEgp: 900,
      staleAfterMinutes: 120,
    });
    const r = await rows();
    expect(r.map((x) => x.who)).toEqual(["A", "owner"]);
    expect(new Set(r.map((x) => x.kind))).toEqual(new Set(["collection_stale"]));
    expect(new Set(r.map((x) => x.link))).toEqual(new Set(["/collections?status=pending&stale=1"]));
    expect(new Set(r.map((x) => x.branchId))).toEqual(new Set([branch1]));
    expect(pushedTo()).toEqual(["A", "owner"]);
    const data = notifyMock.mock.calls[0]![2].data;
    expect(data.type).toBe("collection_stale");
    expect(data.route).toBe("/collections?status=pending&stale=1");
    expect(mailMock).not.toHaveBeenCalled();
  });

  it("stale on branch 2 → the owner + C only", async () => {
    await fanoutEvent(tenantId, branch2, "collection.stale", {
      branchName: "Second",
      count: 1,
      amountEgp: 100,
      staleAfterMinutes: 60,
    });
    expect((await rows()).map((x) => x.who)).toEqual(["C", "owner"]);
  });

  it("pending by A (the actor) → the owner only, in-app with no push (digest mode)", async () => {
    await fanoutEvent(tenantId, branch1, "collection.pending", {
      invoiceId: "INV-1",
      sourceType: "sale",
      method: "instapay",
      amountEgp: 250,
      partsCount: 1,
      accountLabel: "CIB",
      customerName: null,
      branchName: "Main",
      actorUserId: U.A,
      link: "/collections?status=pending",
    });
    const r = await rows();
    expect(r.map((x) => x.who)).toEqual(["owner"]);
    expect(r[0]!.kind).toBe("collection_pending");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("source_silent with no branch → the owner + D (manage_collection_accounts); email to the owner only", async () => {
    await fanoutEvent(tenantId, null, "collection.source_silent", {
      deviceId: randomUUID(),
      deviceLabel: "Owner iPhone",
      platform: "ios_shortcut",
      missedCount: 3,
      branchName: null,
      link: "/settings/collections",
    });
    const r = await rows();
    expect(r.map((x) => x.who)).toEqual(["D", "owner"]);
    expect(new Set(r.map((x) => x.link))).toEqual(new Set(["/settings/collections"]));
    expect(pushedTo()).toEqual(["D", "owner"]);
    // The server's mobile route override points the push at the devices screen.
    expect(notifyMock.mock.calls[0]![2].data.route).toBe("/settings/collections/devices");
    // D13-2: owners get the email by default, staff never.
    expect(mailMock).toHaveBeenCalledTimes(1);
    const mail = mailMock.mock.calls[0]![0] as { to: string; subject: string };
    expect(mail.to).toBe(`fanout-owner-${tag}@test.local`);
    expect(mail.subject).toContain(`Fanout Shop ${tag}`);
  });

  it("limit_warning → the owner + D, in-app only (push off by default), producer link kept", async () => {
    const link = `/collections?tab=totals&account=${randomUUID()}&warning=day_80`;
    await fanoutEvent(tenantId, branch1, "collection.limit_warning", {
      accountId: randomUUID(),
      accountLabel: "VF cash",
      accountMask: "***0150",
      provider: "vodafone_cash",
      warning: "day_80",
      receivedEgp: 48_000,
      limitEgp: 60_000,
      link,
    });
    const r = await rows();
    expect(r.map((x) => x.who)).toEqual(["D", "owner"]);
    expect(new Set(r.map((x) => x.link))).toEqual(new Set([link]));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("unmatched_credit without a link → the owner + A, linked to the credits tab", async () => {
    await fanoutEvent(tenantId, branch1, "collection.unmatched_credit", {
      creditId: randomUUID(),
      accountId: null,
      accountLabel: null,
      amount: 75,
      state: "unmatched",
      holdReason: null,
      suggestedCollectionId: null,
    });
    const r = await rows();
    expect(r.map((x) => x.who)).toEqual(["A", "owner"]);
    expect(new Set(r.map((x) => x.link))).toEqual(new Set(["/collections?tab=credits"]));
    expect(pushedTo()).toEqual(["A", "owner"]);
  });

  it("a stored push=false mutes the owner's stale push; in-app=false drops A's row", async () => {
    await withTenant(tenantId, async (tx) => {
      await tx.insert(notificationPreferences).values([
        { tenantId, userId: U.owner, eventType: "collection.stale", inApp: true, push: false, email: false, digestMode: "instant" },
        { tenantId, userId: U.A, eventType: "collection.stale", inApp: false, push: true, email: false, digestMode: "instant" },
      ]);
    });
    await fanoutEvent(tenantId, branch1, "collection.stale", {
      branchName: "Main",
      count: 1,
      amountEgp: 10,
      staleAfterMinutes: 120,
    });
    expect((await rows()).map((x) => x.who)).toEqual(["owner"]);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("legacy events are unchanged: low stock still reaches the owner only", async () => {
    await fanoutEvent(tenantId, branch1, "inventory.low_stock", {
      productName: "Widget",
      remainingQty: 1,
      threshold: 5,
    });
    const r = await rows();
    expect(r.map((x) => x.who)).toEqual(["owner"]);
    expect(r[0]!.kind).toBe("low_stock");
  });
});

describe("preferences GET visibility (D13-8)", () => {
  const events = async (userId: string) =>
    (await getNotificationPreferences(tenantId, userId)).preferences.map((p) => p.eventType);

  it("lists the collection events only to members who can receive them", async () => {
    // 11 = five legacy + sale.alert (doc 16) + five collection events.
    expect(await events(U.owner)).toHaveLength(11);
    const b = await events(U.B);
    // B holds view_sales → the five legacy events + sale.alert.
    expect(b).toHaveLength(6);
    expect(b).toContain("sale.alert");
    expect(b.some((e) => e.startsWith("collection."))).toBe(false);
    // A has no view_sales → no sale.alert.
    expect(await events(U.A)).toEqual([
      "sale.created",
      "purchase.received",
      "inventory.low_stock",
      "payment.deferred_settled",
      "leave.requested",
      "collection.pending",
      "collection.stale",
      "collection.unmatched_credit",
    ]);
    expect((await events(U.D)).filter((e) => e.startsWith("collection."))).toEqual([
      "collection.source_silent",
      "collection.limit_warning",
    ]);
  });

  it("reports the collection defaults for the owner", async () => {
    const prefs = (await getNotificationPreferences(tenantId, U.owner)).preferences;
    const byEvent = Object.fromEntries(prefs.map((p) => [p.eventType, p]));
    expect(byEvent["collection.pending"]).toMatchObject({ inApp: true, push: false, email: false, digestMode: "digest", isDefault: true });
    expect(byEvent["collection.stale"]).toMatchObject({ inApp: true, push: true, digestMode: "instant" });
    expect(byEvent["collection.limit_warning"]).toMatchObject({ inApp: true, push: false, digestMode: "instant" });
    expect(byEvent["collection.source_silent"]).toMatchObject({ push: true, email: true });
  });

  it("sale.alert (doc 16 §7): hidden without view_sales, default push ON, push-only rows", async () => {
    expect(await events(U.A)).not.toContain("sale.alert");
    const pref = async (u: string) =>
      (await getNotificationPreferences(tenantId, u)).preferences.find((p) => p.eventType === "sale.alert");
    expect(await pref(U.owner)).toMatchObject({ inApp: false, push: true, email: false, digestMode: "instant", isDefault: true });
    expect(await pref(U.B)).toMatchObject({ push: true, isDefault: true });

    // PUT push:false with junk in the other channels → a coerced row.
    expect(
      await setNotificationPreference(tenantId, U.B, {
        eventType: "sale.alert",
        inApp: true,
        push: false,
        email: true,
        digestMode: "digest",
      }),
    ).toEqual({ isDefault: false });
    const stored = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, U.B)),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ eventType: "sale.alert", inApp: false, push: false, email: false, digestMode: "instant" });
    expect(await pref(U.B)).toMatchObject({ push: false, isDefault: false });

    // PUT push:true (again with junk) → back to default, the row is deleted.
    expect(
      await setNotificationPreference(tenantId, U.B, {
        eventType: "sale.alert",
        inApp: true,
        push: true,
        email: true,
        digestMode: "digest",
      }),
    ).toEqual({ isDefault: true });
    const after = await withTenant(tenantId, (tx) =>
      tx.select().from(notificationPreferences).where(eq(notificationPreferences.userId, U.B)),
    );
    expect(after).toHaveLength(0);
  });

  it("sale.created never pushes, even for an owner who made it instant with push on (doc 16 §5)", async () => {
    await setNotificationPreference(tenantId, U.owner, {
      eventType: "sale.created",
      inApp: true,
      push: true,
      email: false,
      digestMode: "instant",
    });
    await fanoutEvent(tenantId, branch1, "sale.created", { invoiceId: "INV-X", totalEgp: 10, lineCount: 1 });
    const r = await rows();
    expect(r.map((x) => x.who)).toEqual(["owner"]);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("with COLLECTIONS_ENABLED=off everyone sees the five legacy events", async () => {
    process.env.COLLECTIONS_ENABLED = "off";
    try {
      expect(await events(U.owner)).toHaveLength(6);
      expect(await events(U.A)).toHaveLength(5);
    } finally {
      process.env.COLLECTIONS_ENABLED = "on";
    }
  });

  it("pilot mode admits only listed tenants", async () => {
    const prevList = process.env.COLLECTIONS_PILOT_TENANT_IDS;
    process.env.COLLECTIONS_ENABLED = "pilot";
    try {
      process.env.COLLECTIONS_PILOT_TENANT_IDS = randomUUID();
      expect(await events(U.owner)).toHaveLength(6);
      process.env.COLLECTIONS_PILOT_TENANT_IDS = ` ${tenantId.toUpperCase()} `;
      expect(await events(U.owner)).toHaveLength(11);
    } finally {
      process.env.COLLECTIONS_ENABLED = "on";
      if (prevList === undefined) delete process.env.COLLECTIONS_PILOT_TENANT_IDS;
      else process.env.COLLECTIONS_PILOT_TENANT_IDS = prevList;
    }
  });
});
