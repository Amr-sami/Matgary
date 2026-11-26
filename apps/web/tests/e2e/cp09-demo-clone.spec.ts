import { expect, test, type APIRequestContext } from "@playwright/test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// CP-09 — the trial-store clone flow (mobile-dev-docs/07-testing-and-e2e.md §3).
//
// The web's "تصفح المتجر التجريبي" button is a Next server action
// (startDemoSession), which cannot be called over plain HTTP. The native plane
// exposes the same journey as POST /api/v1/auth/demo: same rate-limit bucket
// (demo.start, DEMO_LIMIT per DEMO_WINDOW_SEC), same findDemoTemplate() guard,
// same createDemoClone() through the BYPASSRLS admin pool, and it mints a
// bearer session instead of a cookie. That is what this spec drives — pure
// HTTP, no browser.
//
// Asserted, in order:
//   • the template guard: TEMPLATE_MISSING is a legible 503, not a 500 — this
//     is exactly what a stray `db:seed:rich` causes (doc 07 §7.2)
//   • a NEW tenant exists, the visitor is signed in, and the clone carries a
//     subscription row (nothing 402s)
//   • /sales, /inventory (products) and /insights render WITH data
//   • leaving the demo (logout) revokes the session, and the stale JWT does
//     not get back in
//   • (opt-in) the 11th clone from one IP inside the hour is RATE_LIMITED
//
// Skips cleanly when no server is reachable at PLAYWRIGHT_BASE_URL. The
// "tenant deleted → stale JWT is dead" clause and the clone reaping talk to
// Postgres directly (ADMIN_DATABASE_URL, else DATABASE_URL — same as cp10) and
// skip loudly when neither is set.
test.describe.configure({ mode: "serial" });
test.use({ storageState: { cookies: [], origins: [] } });

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

interface DemoSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; email: string; role: string | null; permissions: string[] };
  tenant: { id: string; slug: string | null; subscriptionAccessActive: boolean };
  deviceId: string | null;
  demo: boolean;
}

/** `@/lib/demo/clone-tenant` is `server-only` and can never load in the
 *  Playwright worker, so this is deleteDemoClone() re-issued over Postgres:
 *  the same advisory lock and the same guarded DELETE (only rows that ARE
 *  clones — demo_template_id is set — can go). Prefers the BYPASSRLS admin
 *  URL the helper itself uses; tenants carries no RLS, so DATABASE_URL works. */
const reapDbUrl = (): string | undefined =>
  process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;

async function reapClones(ids: string[]): Promise<void> {
  const url = reapDbUrl();
  if (!url || ids.length === 0) return;
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    for (const id of ids) {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('demo:' || ${id}::text, 0))`,
        );
        await tx.execute(
          sql`delete from tenants where id = ${id}::uuid and demo_template_id is not null`,
        );
      });
    }
  } finally {
    await client.end();
  }
}

/** Best-effort: clear ONLY the demo.start rate-limit ZSETs via the app's Redis. */
async function resetDemoRateLimit(): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout } = await run("docker", [
      "exec", "matgary-redis", "redis-cli", "--scan", "--pattern", "*:rl:demo.start*",
    ]);
    const keys = stdout.split(/\r?\n/).map((k) => k.trim()).filter(Boolean);
    if (keys.length) await run("docker", ["exec", "matgary-redis", "redis-cli", "DEL", ...keys]);
  } catch {
    // No docker / hosted Redis: the limiter may then trip, which surfaces as a
    // legible 429 rather than a mystery.
  }
}

async function serverReachable(request: APIRequestContext): Promise<boolean> {
  try {
    // Any HTTP answer at all means a server is listening (the login page 200s,
    // an API 401s); a connection refusal throws.
    await request.get("/", { timeout: 5_000, maxRedirects: 0 });
    return true;
  } catch {
    return false;
  }
}

async function startDemo(request: APIRequestContext, installId: string) {
  return request.post("/api/v1/auth/demo", {
    data: { platform: "ios", deviceName: "pw-cp09", installId, locale: "ar" },
  });
}

let session: DemoSession | null = null;
let templateMissing = false;

test.beforeAll(async ({ request }) => {
  if (!(await serverReachable(request))) {
    test.skip(true, `no server at ${process.env.PLAYWRIGHT_BASE_URL ?? "the configured baseURL"}`);
  }
});

test.afterAll(async () => {
  // The bearer plane has no /api/demo/exit (that route is cookie-only); the
  // cron `demo-cleanup` reaps clones on schedule. Reap ours now, best-effort,
  // through the same helper the exit route uses, so a red run does not leave
  // tenants behind on a shared dev database.
  if (!session) return;
  try {
    await reapClones([session.tenant.id]);
  } catch (err) {
    // Not fatal: the cleanup cron owns this — but say so.
    console.warn(`cp09: could not reap demo clone ${session.tenant.id}: ${String(err)}`);
  }
});

test("the clone either starts (201) or fails legibly with TEMPLATE_MISSING (503)", async ({
  request,
}) => {
  await resetDemoRateLimit();
  const res = await startDemo(request, "pw-cp09-start");
  const body = (await res.json()) as Partial<DemoSession> & { error?: string };

  if (res.status() === 503) {
    // Doc 07 §7.2: this is what a stray `db:seed:rich` produces. It must be a
    // typed 503, never a 500 — the app turns it into a "demo unavailable" state.
    expect(body.error).toBe("TEMPLATE_MISSING");
    templateMissing = true;
    return;
  }

  expect(res.status(), JSON.stringify(body)).toBe(201);
  expect(body.demo).toBe(true);
  expect(body.accessToken).toEqual(expect.any(String));
  expect(body.refreshToken).toEqual(expect.any(String));
  expect(body.tenant?.id).toEqual(expect.any(String));
  // clone-tenant.ts writes a subscription row for the clone so nothing 402s.
  expect(body.tenant?.subscriptionAccessActive).toBe(true);
  expect(body.user?.email).toMatch(/@matgary\.demo$/);
  session = body as DemoSession;
});

test("the visitor is signed in to a fresh tenant with the demo flag", async ({ request }) => {
  test.skip(templateMissing, "demo template not seeded (npm run db:seed:demo)");
  const me = await request.get("/api/v1/me", { headers: bearer(session!.accessToken) });
  expect(me.status(), await me.text()).toBe(200);
  const body = (await me.json()) as {
    tenant?: { id?: string; isDemo?: boolean; subscriptionAccessActive?: boolean };
    user?: { id?: string };
  };
  expect(body.user?.id).toBe(session!.user.id);
  expect(body.tenant?.id).toBe(session!.tenant.id);
  if (typeof body.tenant?.isDemo === "boolean") expect(body.tenant.isDemo).toBe(true);
  if (typeof body.tenant?.subscriptionAccessActive === "boolean") {
    expect(body.tenant.subscriptionAccessActive).toBe(true);
  }
});

test("/inventory, /sales and /insights all render with data — nothing 402s", async ({
  request,
}) => {
  test.skip(templateMissing, "demo template not seeded (npm run db:seed:demo)");
  const headers = bearer(session!.accessToken);

  const products = await request.get("/api/products?limit=5", { headers });
  expect(products.status(), await products.text()).toBe(200);
  const productBody = (await products.json()) as { data?: unknown[] } | unknown[];
  const productRows = Array.isArray(productBody) ? productBody : (productBody.data ?? []);
  expect(productRows.length, "the clone should carry the template's products").toBeGreaterThan(0);

  const sales = await request.get("/api/sales?limit=5", { headers });
  expect(sales.status(), await sales.text()).toBe(200);
  const salesBody = (await sales.json()) as { data?: unknown[]; sales?: unknown[] } | unknown[];
  const saleRows = Array.isArray(salesBody)
    ? salesBody
    : (salesBody.data ?? salesBody.sales ?? []);
  expect(saleRows.length, "the clone should carry the template's sales").toBeGreaterThan(0);

  const insights = await request.get("/api/insights/overview", { headers });
  expect(insights.status(), await insights.text()).not.toBe(402);
  expect(insights.status()).toBeLessThan(500);
});

test("leaving the demo revokes the session", async ({
  request,
}) => {
  test.skip(templateMissing, "demo template not seeded (npm run db:seed:demo)");
  const headers = bearer(session!.accessToken);

  const out = await request.post("/api/v1/auth/logout", {
    headers,
    data: { refreshToken: session!.refreshToken },
  });
  expect([200, 204]).toContain(out.status());

  // The refresh token is dead …
  const refresh = await request.post("/api/v1/auth/refresh", {
    data: { refreshToken: session!.refreshToken },
  });
  expect(refresh.status()).toBe(401);
});

test("once the clone is deleted, the stale JWT does not resurrect access", async ({ request }) => {
  test.skip(templateMissing, "demo template not seeded (npm run db:seed:demo)");
  // The access JWT is stateless until it expires, so the proof is the tenant
  // row: delete it the way /api/demo/exit does and re-probe. Needs Postgres.
  test.skip(
    !reapDbUrl(),
    "ADMIN_DATABASE_URL / DATABASE_URL not set — the spec deletes the clone row directly",
  );
  const headers = bearer(session!.accessToken);
  await reapClones([session!.tenant.id]);
  const me = await request.get("/api/v1/me", { headers });
  expect([401, 403, 404], await me.text()).toContain(me.status());
  session = null;
});

test("the 11th clone from one IP inside the hour is RATE_LIMITED", async ({ request }) => {
  // Each attempt clones a whole tenant, and the bucket is per IP per hour, so
  // this would starve every other demo start on a shared dev box. Opt in.
  test.skip(
    process.env.E2E_DEMO_RATE_LIMIT !== "1",
    "set E2E_DEMO_RATE_LIMIT=1 to run — clones 11 tenants and exhausts the IP bucket",
  );
  test.skip(templateMissing, "demo template not seeded (npm run db:seed:demo)");
  test.setTimeout(10 * 60_000);
  await resetDemoRateLimit();

  const made: string[] = [];
  let limited: number | null = null;
  for (let i = 1; i <= 11; i += 1) {
    const res = await startDemo(request, `pw-cp09-rl-${i}`);
    if (res.status() === 429) {
      expect(((await res.json()) as { error: string }).error).toBe("RATE_LIMITED");
      limited = i;
      break;
    }
    expect(res.status(), `attempt ${i}`).toBe(201);
    made.push(((await res.json()) as DemoSession).tenant.id);
  }
  // DEMO_LIMIT = 10: the 11th is the first refusal. (Fewer if an earlier run
  // in the same hour already spent part of the bucket.)
  expect(limited).not.toBeNull();
  expect(limited!).toBeLessThanOrEqual(11);

  try {
    await reapClones(made);
  } catch (err) {
    // demo-cleanup cron reaps what is left — but say so.
    console.warn(`cp09: could not reap ${made.length} rate-limit clones: ${String(err)}`);
  }
});
