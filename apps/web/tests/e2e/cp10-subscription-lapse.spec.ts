import { expect, test, type APIRequestContext } from "@playwright/test";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { freshOwner } from "./helpers/tenant-setup";
import { seedOwner } from "./helpers/seed-owner";

// CP-10 — subscription lapse → 402 → recovery (mobile-dev-docs/07 §3).
//
//   GIVEN  an owner whose subscription row is status='expired'
//   THEN   GET  /api/products    → 402 {"error":"SUBSCRIPTION_REQUIRED"}
//   AND    GET  /api/billing/me  → 200   (allow-listed)
//   AND    GET  /api/v1/me       → 200 with the wall named, not a 402
//   WHEN   the row is set status='active', current_period_ends_at in the future
//   THEN   within 60s (the user-context cache) the API returns 200 again
//
// How the subscription is flipped: there is no API for it (Paymob's webhook is
// the only writer), so the spec does what helpers/seed-owner.ts does and talks
// to Postgres directly over DATABASE_URL. It seeds ITS OWN owner first — the
// shared seeded owner is used by every other spec in the same run, and
// expiring it would fail them all.
//
// The harness's own trap (doc 07 §7.3), documented here so nobody rediscovers
// it: subscription state rides in the bearer's `sub_ok` claim, which is set
// at mint time from a 60-second user-context cache. Flipping the row does
// nothing to the token in hand. The client sees the change only after a
// /api/v1/auth/refresh AND the cache expiring (or being busted). The spec
// busts the cache through the app's Redis when docker is at hand, and
// otherwise polls refresh for up to 70s — which is the "within 60s" clause.
//
// Skips cleanly when no server is reachable, or DATABASE_URL is unset.
test.describe.configure({ mode: "serial" });
test.use({ storageState: { cookies: [], origins: [] } });

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; email: string; role: string | null; permissions: string[] };
  tenant: { id: string; slug: string | null; subscriptionAccessActive: boolean };
  deviceId: string | null;
}

async function dockerRedis(args: string[]): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout } = await run("docker", ["exec", "matgary-redis", "redis-cli", ...args]);
    return stdout;
  } catch {
    return null;
  }
}

/** Delete keys matching a pattern in the app's Redis. Best-effort; false when no docker. */
async function redisDelPattern(pattern: string): Promise<boolean> {
  const scan = await dockerRedis(["--scan", "--pattern", pattern]);
  if (scan === null) return false;
  const keys = scan.split(/\r?\n/).map((k) => k.trim()).filter(Boolean);
  if (keys.length) await dockerRedis(["DEL", ...keys]);
  return true;
}

async function serverReachable(request: APIRequestContext): Promise<boolean> {
  try {
    await request.get("/", { timeout: 5_000, maxRedirects: 0 });
    return true;
  } catch {
    return false;
  }
}

async function login(request: APIRequestContext, identifier: string, password: string) {
  // login.email is 5 per 15 minutes; this suite signs in once, but the IP
  // bucket is shared with every other native spec in the run.
  await redisDelPattern("*:rl:login.*");
  const res = await request.post("/api/v1/auth/login", {
    data: { identifier, password, platform: "ios", deviceName: "pw-cp10", installId: "pw-cp10" },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as LoginResult;
}

type SubscriptionState =
  | { status: "expired" }
  | { status: "active"; periodEndsAt: Date };

/** Write the subscription row the way the billing webhook would, via DATABASE_URL. */
async function setSubscription(tenantId: string, state: SubscriptionState): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    if (state.status === "expired") {
      await db.execute(sql`
        insert into subscriptions (tenant_id, plan, status, trial_ends_at, current_period_start, current_period_ends_at, updated_at)
        values (${tenantId}, 'trial', 'expired', now() - interval '1 day', null, null, now())
        on conflict (tenant_id) do update
          set status = 'expired',
              trial_ends_at = now() - interval '1 day',
              current_period_ends_at = null,
              updated_at = now()
      `);
    } else {
      await db.execute(sql`
        insert into subscriptions (tenant_id, plan, status, trial_ends_at, current_period_start, current_period_ends_at, updated_at)
        values (${tenantId}, 'professional', 'active', now() - interval '1 day', now(), ${state.periodEndsAt.toISOString()}::timestamptz, now())
        on conflict (tenant_id) do update
          set plan = 'professional',
              status = 'active',
              current_period_start = now(),
              current_period_ends_at = ${state.periodEndsAt.toISOString()}::timestamptz,
              updated_at = now()
      `);
    }
  } finally {
    await client.end();
  }
}

/**
 * Refresh until the minted token reports the wanted subscription state. The
 * refresh token rotates on every call and reuse is punished, so the newest
 * pair is always carried forward. Up to ~70s: the 60s cache plus slack.
 */
async function refreshUntil(
  request: APIRequestContext,
  tokens: { accessToken: string; refreshToken: string },
  wanted: { subscriptionAccessActive: boolean },
): Promise<{ accessToken: string; refreshToken: string; waitedMs: number }> {
  const started = Date.now();
  let current = tokens;
  for (;;) {
    const res = await request.post("/api/v1/auth/refresh", {
      data: { refreshToken: current.refreshToken },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { accessToken: string; refreshToken: string };
    current = { accessToken: body.accessToken, refreshToken: body.refreshToken };

    const me = await request.get("/api/v1/me", { headers: bearer(current.accessToken) });
    expect(me.status(), await me.text()).toBe(200);
    const meBody = (await me.json()) as { tenant?: { subscriptionAccessActive?: boolean } };
    if (meBody.tenant?.subscriptionAccessActive === wanted.subscriptionAccessActive) {
      return { ...current, waitedMs: Date.now() - started };
    }
    if (Date.now() - started > 70_000) {
      throw new Error(
        `subscriptionAccessActive never became ${wanted.subscriptionAccessActive} within 70s`,
      );
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

const owner = freshOwner("cp10");
let tenantId = "";
let userId = "";
let tokens: { accessToken: string; refreshToken: string } | null = null;

test.beforeAll(async ({ request }) => {
  if (!(await serverReachable(request))) {
    test.skip(true, `no server at ${process.env.PLAYWRIGHT_BASE_URL ?? "the configured baseURL"}`);
  }
  if (!process.env.DATABASE_URL) {
    test.skip(true, "DATABASE_URL not set — the spec flips the subscription row directly");
  }
  test.setTimeout(120_000);
  const seeded = await seedOwner(owner);
  tenantId = seeded.tenantId;
  userId = seeded.userId;
});

test("a fresh owner is trialing: the API answers 200", async ({ request }) => {
  const s = await login(request, owner.email, owner.password);
  expect(s.tenant.id).toBe(tenantId);
  expect(s.tenant.subscriptionAccessActive).toBe(true);
  tokens = { accessToken: s.accessToken, refreshToken: s.refreshToken };
  const products = await request.get("/api/products?limit=1", { headers: bearer(s.accessToken) });
  expect(products.status(), await products.text()).toBe(200);
});

test("status='expired' → /api/products is 402 SUBSCRIPTION_REQUIRED; allow-listed routes stay 200", async ({
  request,
}) => {
  test.setTimeout(120_000);
  await setSubscription(tenantId, { status: "expired" });

  // §7.3: the token in hand still says sub_ok=true. Bust the 60s user-context
  // cache when we can reach Redis, then refresh until the claim flips.
  const busted = await redisDelPattern(`*userctx*${userId}*`);
  test.info().annotations.push({
    type: "note",
    description: busted ? "user-context cache busted via docker redis" : "no docker redis — waited out the 60s cache",
  });
  const fresh = await refreshUntil(request, tokens!, { subscriptionAccessActive: false });
  tokens = fresh;
  const headers = bearer(fresh.accessToken);

  // The wall.
  const products = await request.get("/api/products?limit=1", { headers });
  expect(products.status()).toBe(402);
  expect((await products.json()) as { error: string }).toEqual({ error: "SUBSCRIPTION_REQUIRED" });

  const sales = await request.get("/api/sales?limit=1", { headers });
  expect(sales.status()).toBe(402);

  // Allow-listed: the client needs these to explain the wall and get out of it.
  const billing = await request.get("/api/billing/me", { headers });
  expect(billing.status(), await billing.text()).toBe(200);

  const me = await request.get("/api/v1/me", { headers });
  expect(me.status(), await me.text()).toBe(200);
  const meBody = (await me.json()) as {
    tenant?: { subscriptionAccessActive?: boolean };
    walls?: string[];
  };
  expect(meBody.tenant?.subscriptionAccessActive).toBe(false);
  if (Array.isArray(meBody.walls)) expect(meBody.walls).toContain("SUBSCRIPTION_REQUIRED");

});

test("POST /api/account/password is allow-listed under the wall (bearer transport)", async ({
  request,
}) => {
  // Doc 07 CP-10: "POST /api/account/password/... → not 402 (allow-listed)".
  // True for the cookie transport — middleware.ts exempts /api/account/password
  // from the subscription gate — but the route itself calls
  // requireTenant({ allowPasswordChangeRequired: true }) WITHOUT
  // allowSubscriptionRequired, so a bearer is 402'd before the handler runs.
  // The two transports are documented as behaviourally identical; they are
  // not here. Marked as an expected failure so the gap stays visible: when the
  // route gains allowSubscriptionRequired this test "passes unexpectedly" —
  // delete the test.fail() line and it becomes the regression guard.
  test.fail(true, "bearer transport 402s /api/account/password; cookie transport does not");
  const pw = await request.post("/api/account/password", {
    headers: bearer(tokens!.accessToken),
    data: { currentPassword: "definitely-wrong", newPassword: "AnotherPass123!" },
  });
  expect(pw.status()).not.toBe(402);
});

test("status='active' with a future period end → 200 again within the 60s cache window", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const periodEndsAt = new Date(Date.now() + 30 * 86_400_000);
  await setSubscription(tenantId, { status: "active", periodEndsAt });
  await redisDelPattern(`*userctx*${userId}*`);

  const fresh = await refreshUntil(request, tokens!, { subscriptionAccessActive: true });
  tokens = fresh;
  expect(fresh.waitedMs, "recovery must land inside the 60s user-context cache (+ slack)").toBeLessThan(70_000);

  const headers = bearer(fresh.accessToken);
  const products = await request.get("/api/products?limit=1", { headers });
  expect(products.status(), await products.text()).toBe(200);

  const billing = await request.get("/api/billing/me", { headers });
  expect(billing.status()).toBe(200);
  const billingBody = (await billing.json()) as { status?: string; subscription?: { status?: string } };
  const status = billingBody.status ?? billingBody.subscription?.status;
  if (status) expect(status).toBe("active");
});
