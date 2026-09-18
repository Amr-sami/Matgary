import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { db, withTenant } from "@/lib/db";
import {
  notificationPreferences,
  notifications,
  pushReceipts,
  pushTokens,
  tenantMembers,
  tenants,
  users,
} from "@/lib/db/schema";
import {
  EXPO_PUSH_CHUNK,
  EXPO_PUSH_URL,
  EXPO_RECEIPTS_URL,
  getReceipts,
  isExpoPushToken,
  sendPush,
  toExpoRequest,
  type ExpoReceipt,
  type ExpoTicket,
  type PushMessage,
} from "@/lib/push/expo-push";
import { activeTokens, handleOutcomes, notifyUserDevices, routeForNotification } from "@/lib/push/notify";
import { RECEIPT_DELAY_MS, RECEIPT_TTL_MS, drainTenantReceipts } from "@/lib/push/receipts";
import { registerPushToken } from "@/lib/push/register";
import { pushNotification } from "@/lib/repo/notifications";

// ─── Fake Expo ───────────────────────────────────────────────────────────────

type Call = { url: string; init: RequestInit; body: Array<Record<string, unknown>> };

/** A fetch double that records every POST and answers with tickets computed
 *  per message by `ticketFor`. */
function fakeExpo(
  ticketFor: (msg: Record<string, unknown>, i: number) => ExpoTicket = () => ({
    status: "ok",
    id: "ticket",
  }),
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>;
    calls.push({ url: String(url), init: init ?? {}, body });
    return new Response(JSON.stringify({ data: body.map((m, i) => ticketFor(m, i)) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

const notRegistered: ExpoTicket = {
  status: "error",
  message: "not registered",
  details: { error: "DeviceNotRegistered" },
};

const tok = (n: number) => `ExponentPushToken[t${String(n).padStart(4, "0")}]`;

/** A fetch double for getReceipts: answers `{ data: { id: receipt } }` for
 *  every id `receiptFor` returns a receipt for; the rest stay unanswered. */
function fakeReceipts(receiptFor: (id: string) => ExpoReceipt | undefined) {
  const calls: Array<{ url: string; ids: string[] }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const { ids } = JSON.parse(String(init?.body)) as { ids: string[] };
    calls.push({ url: String(url), ids });
    const data: Record<string, ExpoReceipt> = {};
    for (const id of ids) {
      const r = receiptFor(id);
      if (r) data[id] = r;
    }
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

/** A fetch that never answers but honours the abort signal. */
const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  })) as typeof fetch;

// ─── Transport (no DB) ───────────────────────────────────────────────────────

describe("expo-push transport", () => {
  it("recognises both Expo token spellings and nothing else", () => {
    expect(isExpoPushToken("ExponentPushToken[abc]")).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[abc]")).toBe(true);
    expect(isExpoPushToken("ExponentPushToken[]")).toBe(false);
    expect(isExpoPushToken("fcm:abc")).toBe(false);
    expect(isExpoPushToken(42)).toBe(false);
  });

  it("builds the wire payload: sound, default channel, high priority, data passthrough", () => {
    const req = toExpoRequest({
      to: tok(1),
      title: "مخزون منخفض",
      body: "باقي 2",
      data: { type: "low_stock", route: "/inventory", id: "n1" },
    });
    expect(req).toEqual({
      to: tok(1),
      title: "مخزون منخفض",
      body: "باقي 2",
      data: { type: "low_stock", route: "/inventory", id: "n1" },
      sound: "default",
      channelId: "default",
      priority: "high",
    });
    // No empty body key — Expo renders "undefined" otherwise.
    expect("body" in toExpoRequest({ to: tok(1), title: "x" })).toBe(false);
  });

  it("chunks 250 messages into 100/100/50 POSTs to the Expo endpoint, in order", async () => {
    const expo = fakeExpo();
    const messages: PushMessage[] = Array.from({ length: 250 }, (_, i) => ({
      to: tok(i),
      title: `m${i}`,
    }));
    const out = await sendPush(messages, { fetch: expo.fetch });

    expect(expo.calls.map((c) => c.body.length)).toEqual([EXPO_PUSH_CHUNK, EXPO_PUSH_CHUNK, 50]);
    expect(expo.calls.every((c) => c.url === EXPO_PUSH_URL)).toBe(true);
    expect(expo.calls[0]!.init.method).toBe("POST");
    expect((expo.calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    expect(out).toHaveLength(250);
    expect(out.map((o) => o.to)).toEqual(messages.map((m) => m.to));
    expect(out.every((o) => o.ticket.status === "ok")).toBe(true);
  });

  it("flags DeviceNotRegistered and only that", async () => {
    const expo = fakeExpo((m) =>
      m.to === tok(2)
        ? notRegistered
        : m.to === tok(3)
          ? { status: "error", message: "boom", details: { error: "MessageTooBig" } }
          : { status: "ok", id: "ok" },
    );
    const out = await sendPush(
      [1, 2, 3].map((n) => ({ to: tok(n), title: "t" })),
      { fetch: expo.fetch },
    );
    expect(out.map((o) => o.deviceNotRegistered)).toEqual([false, true, false]);
    expect(out[2]!.ticket.status).toBe("error");
  });

  it("turns an HTTP failure into one error ticket per message and keeps going", async () => {
    let n = 0;
    const flaky = (async (_url: string | URL | Request, init?: RequestInit) => {
      n += 1;
      const body = JSON.parse(String(init?.body)) as unknown[];
      if (n === 1) return new Response("gateway", { status: 502 });
      return new Response(
        JSON.stringify({ data: body.map(() => ({ status: "ok", id: "x" })) }),
        { status: 200 },
      );
    }) as typeof fetch;
    const out = await sendPush(
      Array.from({ length: 120 }, (_, i) => ({ to: tok(i), title: "t" })),
      { fetch: flaky },
    );
    expect(out.slice(0, 100).every((o) => o.ticket.status === "error" && !o.deviceNotRegistered)).toBe(true);
    expect(out.slice(100).every((o) => o.ticket.status === "ok")).toBe(true);
  });

  it("sends an empty list without touching the network", async () => {
    const expo = fakeExpo();
    expect(await sendPush([], { fetch: expo.fetch })).toEqual([]);
    expect(expo.calls).toHaveLength(0);
  });

  it("aborts a hung Expo call after the timeout and degrades into error tickets", async () => {
    const started = Date.now();
    const out = await sendPush([{ to: tok(1), title: "t" }], { fetch: hangingFetch, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out).toHaveLength(1);
    expect(out[0]!.ticket.status).toBe("error");
    expect(out[0]!.deviceNotRegistered).toBe(false);
  });

  it("fetches receipts in one POST and returns only the ones Expo has", async () => {
    const expo = fakeReceipts((id) =>
      id === "a" ? { status: "ok" } : id === "b" ? notRegistered : undefined,
    );
    const receipts = await getReceipts(["a", "b", "c"], { fetch: expo.fetch });
    expect(expo.calls).toEqual([{ url: EXPO_RECEIPTS_URL, ids: ["a", "b", "c"] }]);
    expect(receipts.get("a")).toEqual({ status: "ok" });
    expect(receipts.get("b")?.status).toBe("error");
    expect(receipts.has("c")).toBe(false);
    expect(await getReceipts([], { fetch: expo.fetch })).toEqual(new Map());
  });

  it("returns no receipts (disables nothing) when the receipts call fails", async () => {
    const receipts = await getReceipts(["a"], { fetch: hangingFetch, timeoutMs: 50 });
    expect(receipts.size).toBe(0);
  });
});

describe("route mapping", () => {
  it("prefers the producer link, falls back to the kind table, then the inbox", () => {
    expect(routeForNotification("low_stock", null)).toBe("/inventory");
    expect(routeForNotification("task_assigned", undefined)).toBe("/tasks");
    expect(routeForNotification("leave_decided", null)).toBe("/leave");
    expect(routeForNotification("info", "/sales")).toBe("/sales");
    expect(routeForNotification("info", "/purchases/abc")).toBe("/purchases/abc");
    expect(routeForNotification("info", null)).toBe("/notifications");
    // Never a protocol-relative escape.
    expect(routeForNotification("info", "//evil.example")).toBe("/notifications");
  });
});

// ─── Fan-out (DB) ────────────────────────────────────────────────────────────

const adminClient = postgres(process.env.DATABASE_URL!, { max: 1 });
const adminDb = drizzle(adminClient);

let tenantId: string;
let userId: string;
/** A second shop the same phone could sign into — the cross-tenant re-own case. */
let otherTenantId: string;

beforeAll(async () => {
  await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email: `push-${Date.now()}@test.local`, name: "Push Tester", passwordHash: "x" })
      .returning({ id: users.id });
    const [t] = await tx
      .insert(tenants)
      .values({ name: "Push Test Shop", slug: `push-${Math.random().toString(36).slice(2, 8)}` })
      .returning({ id: tenants.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${t!.id}, true)`);
    await tx.insert(tenantMembers).values({ tenantId: t!.id, userId: u!.id, role: "owner" });
    tenantId = t!.id;
    userId = u!.id;
  });
  await db.transaction(async (tx) => {
    const [t] = await tx
      .insert(tenants)
      .values({ name: "Other Shop", slug: `push-b-${Math.random().toString(36).slice(2, 8)}` })
      .returning({ id: tenants.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${t!.id}, true)`);
    await tx.insert(tenantMembers).values({ tenantId: t!.id, userId, role: "owner" });
    otherTenantId = t!.id;
  });
});

afterAll(async () => {
  await adminDb.delete(tenants).where(eq(tenants.id, tenantId));
  await adminDb.delete(tenants).where(eq(tenants.id, otherTenantId));
  await adminDb.delete(users).where(eq(users.id, userId));
  await adminClient.end();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const tid of [tenantId, otherTenantId]) {
    await withTenant(tid, async (tx) => {
      await tx.delete(pushReceipts).where(eq(pushReceipts.tenantId, tid));
      await tx.delete(pushTokens).where(eq(pushTokens.tenantId, tid));
      await tx.delete(notificationPreferences).where(eq(notificationPreferences.tenantId, tid));
      await tx.delete(notifications).where(eq(notifications.tenantId, tid));
    });
  }
});

async function registerToken(token: string, platform: "ios" | "android" = "ios") {
  await withTenant(tenantId, async (tx) => {
    await tx.insert(pushTokens).values({ tenantId, userId, expoToken: token, platform });
  });
}

async function tokenState(token: string, tid = tenantId) {
  return withTenant(tid, async (tx) => {
    const [r] = await tx
      .select({
        tenantId: pushTokens.tenantId,
        userId: pushTokens.userId,
        deviceName: pushTokens.deviceName,
        disabledAt: pushTokens.disabledAt,
      })
      .from(pushTokens)
      .where(and(eq(pushTokens.tenantId, tid), eq(pushTokens.expoToken, token)));
    return r;
  });
}

async function queuedReceipts(tid = tenantId) {
  return withTenant(tid, (tx) =>
    tx
      .select({ ticketId: pushReceipts.ticketId, expoToken: pushReceipts.expoToken })
      .from(pushReceipts)
      .where(eq(pushReceipts.tenantId, tid))
      .orderBy(pushReceipts.ticketId),
  );
}

describe("notifyUserDevices", () => {
  it("pushes to every active token and disables the ones Expo says are dead", async () => {
    await registerToken(tok(10));
    await registerToken(tok(11), "android");
    await withTenant(tenantId, async (tx) => {
      await tx
        .insert(pushTokens)
        .values({ tenantId, userId, expoToken: tok(12), platform: "ios", disabledAt: new Date() });
    });
    const expo = fakeExpo((m) => (m.to === tok(11) ? notRegistered : { status: "ok", id: "ok" }));

    const res = await notifyUserDevices(
      tenantId,
      userId,
      { title: "T", body: "B", data: { type: "task_assigned", route: "/tasks", id: "n" } },
      { fetch: expo.fetch },
    );

    expect(res.status).toBe("sent");
    // The already-disabled token was never sent to.
    expect(expo.calls[0]!.body.map((m) => m.to).sort()).toEqual([tok(10), tok(11)]);
    expect(res.disabled).toEqual([tok(11)]);
    expect((await tokenState(tok(11)))?.disabledAt).toBeInstanceOf(Date);
    expect((await tokenState(tok(10)))?.disabledAt).toBeNull();
    // Only the `ok` ticket is queued for a receipt check.
    expect(await queuedReceipts()).toEqual([{ ticketId: "ok", expoToken: tok(10) }]);
  });

  it("also honours a stored push=false toggle while in_app stays on", async () => {
    await registerToken(tok(21));
    await withTenant(tenantId, async (tx) => {
      await tx.insert(notificationPreferences).values({
        tenantId,
        userId,
        eventType: "inventory.low_stock",
        inApp: true,
        push: false,
        email: false,
      });
    });
    const expo = fakeExpo();
    const res = await notifyUserDevices(
      tenantId,
      userId,
      { title: "T", data: { type: "low_stock", route: "/inventory", id: null } },
      { fetch: expo.fetch },
    );
    expect(res.status).toBe("muted");
    expect(expo.calls).toHaveLength(0);
  });

  it("reports no_tokens and skips the network when the user has no live device", async () => {
    const expo = fakeExpo();
    const res = await notifyUserDevices(
      tenantId,
      userId,
      { title: "T", data: { type: "info", route: "/sales", id: null } },
      { fetch: expo.fetch },
    );
    expect(res.status).toBe("no_tokens");
    expect(expo.calls).toHaveLength(0);
  });

  it("honours a stored in_app=false toggle for the mapped event type", async () => {
    await registerToken(tok(20));
    await withTenant(tenantId, async (tx) => {
      await tx.insert(notificationPreferences).values({
        tenantId,
        userId,
        eventType: "inventory.low_stock",
        inApp: false,
        email: false,
      });
    });
    const expo = fakeExpo();
    const res = await notifyUserDevices(
      tenantId,
      userId,
      { title: "T", data: { type: "low_stock", route: "/inventory", id: null } },
      { fetch: expo.fetch },
    );
    expect(res.status).toBe("muted");
    expect(expo.calls).toHaveLength(0);
  });

  it("never pushes a notification row that did not commit", async () => {
    await registerToken(tok(30));
    const expo = fakeExpo();
    const res = await notifyUserDevices(
      tenantId,
      userId,
      {
        title: "T",
        notificationId: "00000000-0000-4000-8000-000000000000",
        data: { type: "task_assigned", route: "/tasks", id: null },
      },
      { fetch: expo.fetch, commitPollDelays: [20, 50, 100] },
    );
    expect(res.status).toBe("uncommitted");
    expect(expo.calls).toHaveLength(0);
  }, 10_000);
});

// ─── Receipts (DB) ───────────────────────────────────────────────────────────

describe("push receipts", () => {
  /** Queue `ok` tickets for tokens 50..52 and back-date them. */
  async function seedReceipts(ageMs: number, ids = ["r50", "r51", "r52"]) {
    const outcomes = ids.map((id, i) => ({
      to: tok(50 + i),
      ticket: { status: "ok" as const, id },
      deviceNotRegistered: false,
    }));
    await handleOutcomes(tenantId, userId, outcomes);
    await withTenant(tenantId, async (tx) => {
      await tx
        .update(pushReceipts)
        .set({ createdAt: new Date(Date.now() - ageMs) })
        .where(eq(pushReceipts.tenantId, tenantId));
    });
  }

  it("disables the token whose RECEIPT says DeviceNotRegistered and forgets checked tickets", async () => {
    for (const n of [50, 51, 52]) await registerToken(tok(n));
    await seedReceipts(RECEIPT_DELAY_MS + 1_000);
    const expo = fakeReceipts((id) =>
      id === "r50" ? { status: "ok" } : id === "r51" ? notRegistered : undefined,
    );

    const r = await drainTenantReceipts(tenantId, { fetch: expo.fetch });

    expect(expo.calls[0]!.ids.sort()).toEqual(["r50", "r51", "r52"]);
    expect(r).toMatchObject({ checked: 2, disabled: 1, pending: 1, expired: 0 });
    expect((await tokenState(tok(51)))?.disabledAt).toBeInstanceOf(Date);
    expect((await tokenState(tok(50)))?.disabledAt).toBeNull();
    // r52 had no receipt yet → still queued for next tick; the rest are gone.
    expect(await queuedReceipts()).toEqual([{ ticketId: "r52", expoToken: tok(52) }]);
  });

  it("leaves fresh tickets alone and drops tickets older than the receipt TTL unread", async () => {
    await registerToken(tok(50));
    await seedReceipts(1_000, ["fresh"]);
    const expo = fakeReceipts(() => undefined);
    expect(await drainTenantReceipts(tenantId, { fetch: expo.fetch })).toMatchObject({
      checked: 0,
      pending: 0,
      expired: 0,
    });
    expect(expo.calls).toHaveLength(0);

    await withTenant(tenantId, async (tx) => {
      await tx
        .update(pushReceipts)
        .set({ createdAt: new Date(Date.now() - RECEIPT_TTL_MS - 1_000) })
        .where(eq(pushReceipts.tenantId, tenantId));
    });
    expect(await drainTenantReceipts(tenantId, { fetch: expo.fetch })).toMatchObject({ expired: 1 });
    expect(await queuedReceipts()).toEqual([]);
    expect((await tokenState(tok(50)))?.disabledAt).toBeNull();
  });
});

// ─── Registration (DB) ───────────────────────────────────────────────────────

describe("registerPushToken", () => {
  it("keeps the stored device label when a re-register omits deviceName", async () => {
    await registerPushToken(tenantId, userId, { token: tok(60), platform: "ios", deviceName: "review-sim" });
    await registerPushToken(tenantId, userId, { token: tok(60), platform: "ios" });
    expect((await tokenState(tok(60)))?.deviceName).toBe("review-sim");
    await registerPushToken(tenantId, userId, { token: tok(60), platform: "ios", deviceName: "renamed" });
    expect((await tokenState(tok(60)))?.deviceName).toBe("renamed");
  });

  it("re-registering a disabled token brings it back", async () => {
    await registerPushToken(tenantId, userId, { token: tok(61), platform: "android" });
    await withTenant(tenantId, async (tx) => {
      await tx.update(pushTokens).set({ disabledAt: new Date() }).where(eq(pushTokens.expoToken, tok(61)));
    });
    await registerPushToken(tenantId, userId, { token: tok(61), platform: "android" });
    expect((await tokenState(tok(61)))?.disabledAt).toBeNull();
    expect(await activeTokens(tenantId, userId)).toEqual([tok(61)]);
  });

  it("re-owns a token that the same phone registered under ANOTHER tenant", async () => {
    await registerPushToken(tenantId, userId, { token: tok(62), platform: "ios", deviceName: "shared tablet" });
    expect(await activeTokens(tenantId, userId)).toEqual([tok(62)]);

    // Same install, other shop. Under RLS the first row is invisible to
    // tenant B, so this goes through push_token_reown (or the plain upsert
    // when the test role bypasses RLS) — the outcome must be identical.
    await registerPushToken(otherTenantId, userId, { token: tok(62), platform: "ios" });

    const row = await tokenState(tok(62), otherTenantId);
    expect(row).toMatchObject({ tenantId: otherTenantId, userId, deviceName: "shared tablet" });
    expect(row?.disabledAt).toBeNull();
    // Tenant A no longer pushes to a device its user no longer holds.
    expect(await activeTokens(tenantId, userId)).toEqual([]);
    expect(await tokenState(tok(62), tenantId)).toBeUndefined();
    expect(await activeTokens(otherTenantId, userId)).toEqual([tok(62)]);
  });
});

describe("createNotification hook", () => {
  it("fans a real notification out with the { type, route, id } contract once committed", async () => {
    await registerToken(tok(40));
    const expo = fakeExpo();
    vi.stubGlobal("fetch", expo.fetch);

    await pushNotification(tenantId, null, {
      userId,
      kind: "task_assigned",
      title: "مهمة جديدة",
      body: "رتّب الرف",
      link: "/tasks",
    });

    // The hook is fire-and-forget and waits for the commit; poll for the call.
    const deadline = Date.now() + 8_000;
    while (expo.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(expo.calls).toHaveLength(1);
    const [msg] = expo.calls[0]!.body;
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select({ id: notifications.id }).from(notifications).where(eq(notifications.tenantId, tenantId)),
    );
    expect(msg).toMatchObject({
      to: tok(40),
      title: "مهمة جديدة",
      body: "رتّب الرف",
      sound: "default",
      channelId: "default",
      data: { type: "task_assigned", route: "/tasks", id: row!.id, tenantId },
    });
  }, 15_000);

  it("writes the row but does not push when the producer passes push:false (digest-mode events)", async () => {
    await registerToken(tok(41));
    const expo = fakeExpo();
    vi.stubGlobal("fetch", expo.fetch);

    await pushNotification(tenantId, null, {
      userId,
      kind: "info",
      title: "بيع جديد",
      link: "/sales",
      push: false,
    });

    const rows = await withTenant(tenantId, (tx) =>
      tx.select({ id: notifications.id }).from(notifications).where(eq(notifications.tenantId, tenantId)),
    );
    expect(rows).toHaveLength(1);
    // Long enough for the hook's first two poll steps to have fired if it ran.
    await new Promise((r) => setTimeout(r, 600));
    expect(expo.calls).toHaveLength(0);
  }, 5_000);
});
