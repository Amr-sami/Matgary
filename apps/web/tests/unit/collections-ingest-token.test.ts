/**
 * Doc 15 spec 07 §7 — lib/api/ingest-token.ts (no DB).
 *
 * The ingest token's shape, hash and cache key, and `requireIngestDevice`'s
 * ORDER (§4.4): the per-IP bucket refuses BEFORE any parsing or DB work
 * (acceptance 2), unknown tokens are 401 with a negative cache entry,
 * revoked rows 401 INGEST_DEVICE_REVOKED (never cached as valid), suspended
 * tenants 403, and admission follows the env gate on every request
 * (SEC14-F6: no 60 s tail after COLLECTIONS_INGEST_ENABLED goes off).
 *
 * `@/lib/ratelimit`, `@/lib/db` and `@/lib/cache` are faked: the assertions
 * are about the wrapper's contract, not Redis or Postgres.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rl: [] as { scope: string; identifier: string }[],
  blockScope: null as string | null,
  dbCalls: 0,
  dbThrows: false,
  rows: [] as Record<string, unknown>[],
  cache: new Map<string, unknown>(),
  cacheSets: [] as { key: string; value: unknown; ttl: number }[],
  switches: { collections_enabled: true },
}));

vi.mock("@/lib/ratelimit", () => ({
  rateLimit: vi.fn(async (scope: string, identifier: string) => {
    state.rl.push({ scope, identifier });
    if (state.blockScope && scope === state.blockScope) return { ok: false, count: 999, resetAt: Date.now() + 30_000 };
    return { ok: true, count: 1, resetAt: Date.now() + 60_000 };
  }),
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}));

vi.mock("@/lib/cache", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cache")>("@/lib/cache");
  return {
    ...actual,
    cacheGet: vi.fn(async (key: string) => (state.cache.has(key) ? state.cache.get(key) : null)),
    cacheSet: vi.fn(async (key: string, value: unknown, ttl: number) => {
      state.cache.set(key, value);
      state.cacheSets.push({ key, value, ttl });
    }),
    cacheDel: vi.fn(async (...keys: string[]) => {
      for (const k of keys) state.cache.delete(k);
    }),
  };
});

vi.mock("@/lib/db", () => {
  const exec = async () => {
    state.dbCalls++;
    if (state.dbThrows) throw new Error("db must not be touched");
    return state.rows;
  };
  // The flags module reads the branch switches through Drizzle's builder.
  const builder = {
    select: () => builder,
    from: () => builder,
    where: () => builder,
    limit: async () => {
      state.dbCalls++;
      if (state.dbThrows) throw new Error("db must not be touched");
      return [
        {
          collectionsEnabled: state.switches.collections_enabled,
          collectionsAutoConfirmEnabled: false,
        },
      ];
    },
    execute: exec,
  };
  return {
    db: { execute: exec },
    withTenant: async (_t: string, fn: (tx: typeof builder) => unknown) => fn(builder),
  };
});

const T = await import("@/lib/api/ingest-token");
const { PLATFORM_CHANNELS } = await import("@/lib/repo/collection-devices");

const TENANT = "11111111-1111-4111-8111-111111111111";
const BRANCH = "22222222-2222-4222-8222-222222222222";
const DEVICE = "33333333-3333-4333-8333-333333333333";

function req(token: string | null, ip = "203.0.113.7") {
  const h = new Headers({ "x-forwarded-for": ip });
  if (token !== null) h.set("authorization", `Bearer ${token}`);
  return { headers: h };
}

function deviceRow(over: Record<string, unknown> = {}) {
  return {
    id: DEVICE,
    tenant_id: TENANT,
    branch_id: BRANCH,
    platform: "ios_shortcut",
    channels: ["ios_sms", "ios_notification"],
    account_ids: [],
    created_by_user_id: null,
    consent_version: "2026-10-01",
    label: "Owner iPhone",
    revoked_at: null,
    suspended_at: null,
    deletion_scheduled_at: null,
    ...over,
  };
}

const saved = {
  e: process.env.COLLECTIONS_ENABLED,
  i: process.env.COLLECTIONS_INGEST_ENABLED,
  p: process.env.COLLECTIONS_PILOT_TENANT_IDS,
  ip: process.env.COLLECTIONS_INGEST_PILOT_TENANT_IDS,
  rl: process.env.TENANT_RATE_LIMIT_DISABLED,
};

function restore(k: string, v: string | undefined) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

beforeEach(() => {
  state.rl = [];
  state.blockScope = null;
  state.dbCalls = 0;
  state.dbThrows = false;
  state.rows = [];
  state.cache.clear();
  state.cacheSets = [];
  state.switches.collections_enabled = true;
  process.env.COLLECTIONS_ENABLED = "on";
  process.env.COLLECTIONS_INGEST_ENABLED = "on";
  delete process.env.COLLECTIONS_PILOT_TENANT_IDS;
  delete process.env.COLLECTIONS_INGEST_PILOT_TENANT_IDS;
  delete process.env.TENANT_RATE_LIMIT_DISABLED;
});

afterEach(() => {
  restore("COLLECTIONS_ENABLED", saved.e);
  restore("COLLECTIONS_INGEST_ENABLED", saved.i);
  restore("COLLECTIONS_PILOT_TENANT_IDS", saved.p);
  restore("COLLECTIONS_INGEST_PILOT_TENANT_IDS", saved.ip);
  restore("TENANT_RATE_LIMIT_DISABLED", saved.rl);
});

describe("mint / hash / shape (§4.4)", () => {
  it("mints mgi_ + 43 base64url chars; hash = sha256 of the WHOLE string; prefix = chars 4–12", () => {
    const m = T.mintIngestToken();
    expect(m.token.startsWith("mgi_")).toBe(true);
    expect(m.token).toHaveLength(47);
    expect(m.token).toMatch(/^mgi_[A-Za-z0-9_-]{43}$/);
    expect(T.isIngestTokenShape(m.token)).toBe(true);
    expect(m.hash).toBe(createHash("sha256").update(m.token, "utf8").digest("hex"));
    expect(T.hashIngestToken(m.token)).toBe(m.hash);
    expect(m.prefix).toBe(m.token.slice(4, 12));
    expect(m.prefix).toHaveLength(8);
    expect(T.mintIngestToken().token).not.toBe(m.token);
  });

  it("rejects JWTs, a 42-char body, spaces, a missing prefix and non-strings", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlc2lnbmF0dXJl";
    expect(T.isIngestTokenShape(jwt)).toBe(false);
    expect(T.isIngestTokenShape(`mgi_${"a".repeat(42)}`)).toBe(false);
    expect(T.isIngestTokenShape(`mgi_${"a".repeat(44)}`)).toBe(false);
    expect(T.isIngestTokenShape(`mgi_${"a".repeat(20)} ${"a".repeat(22)}`)).toBe(false);
    expect(T.isIngestTokenShape("a".repeat(47))).toBe(false);
    expect(T.isIngestTokenShape(null)).toBe(false);
    expect(T.isIngestTokenShape(undefined)).toBe(false);
  });

  it("the cache key is global, contains :g:ingest: and never the plaintext", () => {
    const m = T.mintIngestToken();
    const k = T.ingestCacheKey(m.hash);
    expect(k).toContain(":g:ingest:");
    expect(k.endsWith(m.hash)).toBe(true);
    expect(k).not.toContain(m.token);
    expect(k).not.toContain("mgi_");
  });

  it("PLATFORM_CHANNELS never contains manual_paste / statement", () => {
    for (const chans of Object.values(PLATFORM_CHANNELS)) {
      expect(chans).not.toContain("manual_paste");
      expect(chans).not.toContain("statement");
    }
  });
});

describe("requireIngestDevice — order and refusals (§4.4, acceptance 1–2)", () => {
  it("the per-IP bucket refuses with 429 BEFORE the bearer is read or the DB is touched", async () => {
    state.blockScope = "tenant.ingest.ip";
    state.dbThrows = true;
    const r = await T.requireIngestDevice(req(T.mintIngestToken().token), "ingest.device");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(429);
    expect((await r.response.json()).error).toBe("RATE_LIMITED");
    expect(state.dbCalls).toBe(0);
    expect(state.rl.map((c) => c.scope)).toEqual(["tenant.ingest.ip"]);
    expect(state.rl[0]!.identifier).toBe("203.0.113.7");
  });

  it("missing or wrong-shape bearer → 401 INGEST_TOKEN_INVALID without a DB query", async () => {
    state.dbThrows = true;
    for (const tok of [null, "mgi_x", "eyJhbGciOi.x.y"]) {
      const r = await T.requireIngestDevice(req(tok), "ingest.device");
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.response.status).toBe(401);
      expect(await r.response.json()).toEqual({ error: "INGEST_TOKEN_INVALID" });
    }
    expect(state.dbCalls).toBe(0);
  });

  it("an unknown well-formed token → 401 and a negative cache entry; the next call is served from it", async () => {
    const m = T.mintIngestToken();
    state.rows = [];
    const r = await T.requireIngestDevice(req(m.token), "ingest.device");
    expect(r.ok).toBe(false);
    if (!r.ok) expect((await r.response.json()).error).toBe("INGEST_TOKEN_INVALID");
    const neg = state.cacheSets.find((s) => s.key === T.ingestCacheKey(m.hash));
    expect(neg?.value).toEqual({ invalid: true });
    expect(neg?.ttl).toBe(60);
    state.dbThrows = true;
    const again = await T.requireIngestDevice(req(m.token), "ingest.device");
    expect(again.ok).toBe(false);
    expect(state.dbCalls).toBe(1);
  });

  it("a revoked row → 401 INGEST_DEVICE_REVOKED and is NOT cached as valid", async () => {
    const m = T.mintIngestToken();
    state.rows = [deviceRow({ revoked_at: "2026-10-19T10:00:00Z" })];
    const r = await T.requireIngestDevice(req(m.token), "ingest.device");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      expect((await r.response.json()).error).toBe("INGEST_DEVICE_REVOKED");
    }
    expect(state.cache.has(T.ingestCacheKey(m.hash))).toBe(false);
  });

  it("a suspended tenant → 403 TENANT_SUSPENDED; deletion scheduled → 403 INGEST_DISABLED", async () => {
    state.rows = [deviceRow({ suspended_at: "2026-10-01T00:00:00Z" })];
    const a = await T.requireIngestDevice(req(T.mintIngestToken().token), "ingest.device");
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.response.status).toBe(403);
      expect((await a.response.json()).error).toBe("TENANT_SUSPENDED");
    }
    state.rows = [deviceRow({ deletion_scheduled_at: "2026-10-01T00:00:00Z" })];
    const b = await T.requireIngestDevice(req(T.mintIngestToken().token), "ingest.device");
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.response.status).toBe(403);
      expect((await b.response.json()).error).toBe("INGEST_DISABLED");
    }
  });

  it("a live device → ok; buckets in order ip → device scope (by device id) → tenant ingest.default; cached valid without the token", async () => {
    const m = T.mintIngestToken();
    state.rows = [deviceRow()];
    const r = await T.requireIngestDevice(req(m.token), "ingest.heartbeat");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dev).toMatchObject({ deviceId: DEVICE, tenantId: TENANT, branchId: BRANCH, platform: "ios_shortcut" });
    expect(state.rl.map((c) => `${c.scope}:${c.identifier}`)).toEqual([
      "tenant.ingest.ip:203.0.113.7",
      `tenant.ingest.heartbeat:${DEVICE}`,
      `tenant.ingest.default:${TENANT}`,
    ]);
    const cached = state.cache.get(T.ingestCacheKey(m.hash)) as Record<string, unknown>;
    expect(cached.revoked).toBe(false);
    expect(JSON.stringify(cached)).not.toContain(m.token);
    for (const s of state.cacheSets) expect(JSON.stringify(s.value)).not.toContain("mgi_");
  });

  it("the device bucket (121st per minute) → 429 after the lookup", async () => {
    state.rows = [deviceRow()];
    state.blockScope = "tenant.ingest.device";
    const r = await T.requireIngestDevice(req(T.mintIngestToken().token), "ingest.device");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(429);
  });

  it("an outdated consent version → 403 INGEST_DISABLED consent_outdated", async () => {
    state.rows = [deviceRow({ consent_version: "2026-09-01" })];
    const r = await T.requireIngestDevice(req(T.mintIngestToken().token), "ingest.device");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(await r.response.json()).toEqual({ error: "INGEST_DISABLED", detail: "consent_outdated" });
  });
});

describe("admission follows the env gate on every request (SEC14-F6)", () => {
  it("COLLECTIONS_INGEST_ENABLED=off bites on the very next request even with an admitted answer cached", async () => {
    const m = T.mintIngestToken();
    state.rows = [deviceRow()];
    const first = await T.requireIngestDevice(req(m.token), "ingest.device");
    expect(first.ok).toBe(true);
    expect([...state.cache.keys()].some((k) => k.includes(":collections-ingest-admit:"))).toBe(true);

    process.env.COLLECTIONS_INGEST_ENABLED = "off";
    const off = await T.requireIngestDevice(req(m.token), "ingest.device");
    expect(off.ok).toBe(false);
    if (!off.ok) {
      expect(off.response.status).toBe(403);
      expect((await off.response.json()).error).toBe("INGEST_DISABLED");
    }
  });

  it("pilot mode admits only the listed tenant (ingest list, else the shared list)", async () => {
    process.env.COLLECTIONS_INGEST_ENABLED = "pilot";
    process.env.COLLECTIONS_PILOT_TENANT_IDS = "99999999-9999-4999-8999-999999999999";
    expect(T.ingestEnvAdmitted(TENANT)).toBe(false);
    process.env.COLLECTIONS_INGEST_PILOT_TENANT_IDS = TENANT.toUpperCase();
    expect(T.ingestEnvAdmitted(TENANT)).toBe(true);
    process.env.COLLECTIONS_ENABLED = "off";
    expect(T.ingestEnvAdmitted(TENANT)).toBe(false);
  });

  it("off → on is not served a stale 'not admitted' answer cached under the old mode", async () => {
    process.env.COLLECTIONS_INGEST_ENABLED = "pilot";
    process.env.COLLECTIONS_PILOT_TENANT_IDS = TENANT;
    state.switches.collections_enabled = false;
    expect(await T.ingestAdmitted(TENANT, BRANCH)).toBe(false);
    state.switches.collections_enabled = true;
    process.env.COLLECTIONS_INGEST_ENABLED = "on";
    expect(await T.ingestAdmitted(TENANT, BRANCH)).toBe(true);
  });

  it("the branch switch is still read (and cached): branch off → not admitted", async () => {
    state.switches.collections_enabled = false;
    expect(await T.ingestAdmitted(TENANT, BRANCH)).toBe(false);
  });
});
