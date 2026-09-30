/**
 * Digital collections 05 §4.15 (step 5) — lib/api/tenant-rate-limit.ts.
 *
 * The five `ingest.*` buckets spec 07 calls exist with the pinned limits;
 * `checkScopedRateLimit(scope, identifier)` keys the limiter by the free
 * identifier (an IP or an ingest device id), answers the house 429 body, and
 * honours the TENANT_RATE_LIMIT_DISABLED escape hatch; `checkTenantRateLimit`
 * keeps its behaviour (keyed by tenant id, log field `tenantId`).
 *
 * The Redis limiter is faked so the assertions are about the wrapper's
 * contract; tests/ratelimit.test.ts covers the real Redis script.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  list: [] as { scope: string; identifier: string; opts: { limit: number; windowSec: number; commit?: boolean } }[],
  verdict: { ok: true, count: 1, resetAt: 0 } as { ok: boolean; count: number; resetAt: number },
}));

vi.mock("@/lib/ratelimit", () => ({
  rateLimit: vi.fn(async (scope: string, identifier: string, opts: { limit: number; windowSec: number; commit?: boolean }) => {
    calls.list.push({ scope, identifier, opts });
    return calls.verdict;
  }),
}));

const logs = vi.hoisted(() => ({ warn: [] as Record<string, unknown>[] }));
vi.mock("@/lib/logger", () => ({
  logger: {
    warn: (o: Record<string, unknown>) => logs.warn.push(o),
    info: () => {},
    error: () => {},
    debug: () => {},
  },
}));

const { checkScopedRateLimit, checkTenantRateLimit, rateLimitBucket } = await import(
  "@/lib/api/tenant-rate-limit"
);

beforeEach(() => {
  calls.list = [];
  calls.verdict = { ok: true, count: 1, resetAt: Date.now() + 60_000 };
  logs.warn = [];
});

afterEach(() => {
  delete process.env.TENANT_RATE_LIMIT_DISABLED;
});

describe("ingest.* buckets (05 §4.15)", () => {
  it.each([
    ["ingest.ip", 60, 60],
    ["ingest.device", 120, 60],
    ["ingest.default", 600, 60],
    ["ingest.heartbeat", 12, 3600],
    ["ingest.config", 60, 3600],
  ])("%s = %i per %i s", (scope, limit, windowSec) => {
    expect(rateLimitBucket(scope)).toEqual({ limit, windowSec });
  });

  it("the pre-existing buckets are unchanged", () => {
    expect(rateLimitBucket("list.default")).toEqual({ limit: 120, windowSec: 60 });
    expect(rateLimitBucket("write.default")).toEqual({ limit: 60, windowSec: 60 });
    expect(rateLimitBucket("wa.send")).toEqual({ limit: 60, windowSec: 60 });
    expect(rateLimitBucket("reports.read")).toEqual({ limit: 30, windowSec: 60 });
  });

  it("rateLimitBucket returns a copy (the registry cannot be mutated through it)", () => {
    const b = rateLimitBucket("ingest.ip")!;
    (b as { limit: number }).limit = 1;
    expect(rateLimitBucket("ingest.ip")).toEqual({ limit: 60, windowSec: 60 });
  });
});

describe("checkScopedRateLimit", () => {
  it("keys by the free identifier under the tenant.<scope> family (rl:tenant.ingest.ip:<ip>)", async () => {
    const r = await checkScopedRateLimit("ingest.ip", "203.0.113.9");
    expect(r.ok).toBe(true);
    expect(calls.list).toEqual([
      { scope: "tenant.ingest.ip", identifier: "203.0.113.9", opts: { limit: 60, windowSec: 60, commit: true } },
    ]);
  });

  it("uses the device bucket's own limits", async () => {
    await checkScopedRateLimit("ingest.heartbeat", "dev-1");
    expect(calls.list[0]).toEqual({
      scope: "tenant.ingest.heartbeat",
      identifier: "dev-1",
      opts: { limit: 12, windowSec: 3600, commit: true },
    });
  });

  it("blocked → 429 {error:RATE_LIMITED, scope, resetAt} + Retry-After; logs `identifier`", async () => {
    const resetAt = Date.now() + 30_000;
    calls.verdict = { ok: false, count: 61, resetAt };
    const r = await checkScopedRateLimit("ingest.ip", "203.0.113.9");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(429);
    expect(await r.response.json()).toEqual({ error: "RATE_LIMITED", scope: "ingest.ip", resetAt });
    expect(Number(r.response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(r.response.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(logs.warn).toHaveLength(1);
    expect(logs.warn[0]).toMatchObject({ event: "tenant.rate_limit.blocked", scope: "ingest.ip", identifier: "203.0.113.9" });
    expect(logs.warn[0]).not.toHaveProperty("tenantId");
  });

  it("TENANT_RATE_LIMIT_DISABLED=1 skips the limiter", async () => {
    process.env.TENANT_RATE_LIMIT_DISABLED = "1";
    const r = await checkScopedRateLimit("ingest.device", "dev-1");
    expect(r.ok).toBe(true);
    expect(calls.list).toHaveLength(0);
  });

  it("an unknown scope falls back to write.default, as the tenant check does", async () => {
    await checkScopedRateLimit("nope.scope", "x");
    expect(calls.list[0]!.opts).toEqual({ limit: 60, windowSec: 60, commit: true });
  });
});

describe("checkTenantRateLimit is unchanged", () => {
  it("keys by tenant id and logs tenantId on a block", async () => {
    calls.verdict = { ok: false, count: 121, resetAt: Date.now() + 1000 };
    const r = await checkTenantRateLimit("tenant-1", "list.default");
    expect(r.ok).toBe(false);
    expect(calls.list[0]).toEqual({
      scope: "tenant.list.default",
      identifier: "tenant-1",
      opts: { limit: 120, windowSec: 60, commit: true },
    });
    expect(logs.warn[0]).toMatchObject({ event: "tenant.rate_limit.blocked", scope: "list.default", tenantId: "tenant-1" });
    expect(logs.warn[0]).not.toHaveProperty("identifier");
  });

  it("ingest.default is a tenant bucket (600/min)", async () => {
    await checkTenantRateLimit("tenant-1", "ingest.default");
    expect(calls.list[0]!.opts).toEqual({ limit: 600, windowSec: 60, commit: true });
  });
});
