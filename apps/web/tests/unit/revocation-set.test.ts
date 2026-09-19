/**
 * Doc 14 §10 H4 — instant revocation of native access tokens.
 *
 * Access tokens are stateless JWTs, so until now a revoked device (or a user
 * who signed out everywhere) kept working for the token's remaining life.
 * The bearer path in lib/api/auth-helpers.ts now consults two Redis markers
 * after the signature check — `revoked:did:<deviceId>` and
 * `revoked:uid:<userId>` — and answers 401 REVOKED when either is present.
 *
 * The cache is mocked with an in-memory map; the token is a REAL signed
 * access token (AUTH_SECRET is set here) so the test covers the real
 * verify → lookup → verdict order. Auth.js and next/headers are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.AUTH_SECRET ??= "revocation-set-test-secret";

const store = new Map<string, { value: string; ttl: number }>();
const cacheGet = vi.fn(async (key: string) => {
  const hit = store.get(key);
  return hit ? JSON.parse(hit.value) : null;
});
const cacheSet = vi.fn(async (key: string, value: unknown, ttl: number) => {
  store.set(key, { value: JSON.stringify(value), ttl });
});

vi.mock("@/lib/cache", () => ({
  cacheGet: (k: string) => cacheGet(k),
  cacheSet: (k: string, v: unknown, t: number) => cacheSet(k, v, t),
  cacheDel: vi.fn(async () => {}),
  cacheRemember: vi.fn(),
  cacheBustPrefix: vi.fn(async () => {}),
  cacheBustTenant: vi.fn(async () => {}),
  globalKey: (...parts: (string | number)[]) => ["g", ...parts.map(String)].join(":"),
  tenantKey: (t: string, ...parts: (string | number)[]) => ["t", t, ...parts.map(String)].join(":"),
}));

let authorization: string | null = null;
vi.mock("next/headers", () => ({
  headers: async () => new Headers(authorization ? { authorization } : {}),
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("@/lib/auth", () => ({
  auth: async () => null,
  resolveTenantContext: async () => ({ tenantSuspendedReason: null }),
}));

const { ACCESS_TTL_SEC, signAccessToken } = await import("@/lib/api/native-token");
const {
  isRevoked,
  issuedBeforeMark,
  markDevicesRevoked,
  markUserRevoked,
  requireTenant,
  revokedDeviceKey,
  revokedUserKey,
} = await import("@/lib/api/auth-helpers");

const USER = "11111111-1111-4111-8111-111111111111";
const DEVICE = "22222222-2222-4222-8222-222222222222";
const TENANT = "33333333-3333-4333-8333-333333333333";

async function bearerFor(did = DEVICE, sub = USER): Promise<string> {
  const token = await signAccessToken({
    sub,
    tenantId: TENANT,
    role: "owner",
    permissions: [],
    tv: 1,
    did,
    susp: null,
    mcp: false,
    sub_ok: true,
  });
  return `Bearer ${token}`;
}

beforeEach(() => {
  store.clear();
  cacheGet.mockClear();
  cacheSet.mockClear();
  authorization = null;
});

afterEach(() => {
  cacheGet.mockImplementation(async (key: string) => {
    const hit = store.get(key);
    return hit ? JSON.parse(hit.value) : null;
  });
});

describe("markers", () => {
  it("markDevicesRevoked writes revoked:did:<id> with the access-token TTL", async () => {
    await markDevicesRevoked([DEVICE, "", "other"]);
    expect(cacheSet).toHaveBeenCalledTimes(2);
    expect(store.get(revokedDeviceKey(DEVICE))?.ttl).toBe(ACCESS_TTL_SEC);
    expect(store.get(revokedDeviceKey("other"))).toBeDefined();
    expect(revokedDeviceKey(DEVICE)).toContain(`revoked:did:${DEVICE}`);
  });

  it("markUserRevoked writes revoked:uid:<id> with the access-token TTL and a timestamp", async () => {
    const before = Date.now();
    await markUserRevoked(USER);
    const entry = store.get(revokedUserKey(USER));
    expect(entry?.ttl).toBe(ACCESS_TTL_SEC);
    expect(JSON.parse(entry!.value).at).toBeGreaterThanOrEqual(before);
    expect(revokedUserKey(USER)).toContain(`revoked:uid:${USER}`);
  });

  it("issuedBeforeMark: an earlier second is revoked; the mark's own second and later pass", () => {
    const at = 1_700_000_000_500; // ms
    expect(issuedBeforeMark(1_700_000_000, { at })).toBe(false); // same second: the session being minted right now
    expect(issuedBeforeMark(1_699_999_999, { at })).toBe(true); // earlier
    expect(issuedBeforeMark(1_700_000_001, { at })).toBe(false); // one second later
    expect(issuedBeforeMark(0, { at })).toBe(true); // unreadable iat = old
    expect(issuedBeforeMark(undefined, { at })).toBe(true);
    expect(issuedBeforeMark(1_700_000_001, 1)).toBe(true); // legacy mark
  });

  it("empty inputs are no-ops", async () => {
    await markDevicesRevoked([]);
    await markUserRevoked("");
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("isRevoked reads both keys and is false on a clean cache", async () => {
    expect(await isRevoked(USER, DEVICE)).toBe(false);
    expect(cacheGet).toHaveBeenCalledWith(revokedUserKey(USER));
    expect(cacheGet).toHaveBeenCalledWith(revokedDeviceKey(DEVICE));
  });
});

describe("bearer path", () => {
  it("a clean signed token passes", async () => {
    authorization = await bearerFor();
    const r = await requireTenant();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ctx.userId).toBe(USER);
    expect(r.ctx.tenantId).toBe(TENANT);
  });

  it("401 REVOKED once the device is marked", async () => {
    authorization = await bearerFor();
    await markDevicesRevoked([DEVICE]);
    const r = await requireTenant();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(401);
    expect(await r.response.json()).toEqual({ error: "REVOKED" });
  });

  it("401 REVOKED for every device once the user is marked", async () => {
    // Revocation lands 2 s after the tokens' issue second: they predate it and
    // are refused (same-second mints pass by design — the re-login after a bump).
    store.set(revokedUserKey(USER), { value: JSON.stringify({ at: Date.now() + 2000 }), ttl: ACCESS_TTL_SEC });
    for (const did of [DEVICE, "44444444-4444-4444-8444-444444444444"]) {
      authorization = await bearerFor(did);
      const r = await requireTenant();
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.response.status).toBe(401);
      expect(await r.response.json()).toEqual({ error: "REVOKED" });
    }
  });

  it("a token minted AFTER 'sign out everywhere' passes (re-login within the TTL)", async () => {
    await markUserRevoked(USER);
    // Pretend the revocation happened two seconds ago.
    const key = revokedUserKey(USER);
    store.set(key, { value: JSON.stringify({ at: Date.now() - 2000 }), ttl: ACCESS_TTL_SEC });
    authorization = await bearerFor();
    const r = await requireTenant();
    expect(r.ok).toBe(true);
  });

  it("a token minted BEFORE 'sign out everywhere' is refused", async () => {
    authorization = await bearerFor();
    // Revocation lands two seconds after the token's issue second.
    const key = revokedUserKey(USER);
    store.set(key, { value: JSON.stringify({ at: Date.now() + 2000 }), ttl: ACCESS_TTL_SEC });
    const r = await requireTenant();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(await r.response.json()).toEqual({ error: "REVOKED" });
  });

  it("the device marker is unconditional (a revoked row never mints again)", async () => {
    await markDevicesRevoked([DEVICE]);
    store.set(revokedDeviceKey(DEVICE), { value: JSON.stringify({ at: 1 }), ttl: ACCESS_TTL_SEC });
    authorization = await bearerFor();
    const r = await requireTenant();
    expect(r.ok).toBe(false);
  });

  it("a marker for another device / user does not bleed over", async () => {
    await markDevicesRevoked(["55555555-5555-4555-8555-555555555555"]);
    await markUserRevoked("66666666-6666-4666-8666-666666666666");
    authorization = await bearerFor();
    const r = await requireTenant();
    expect(r.ok).toBe(true);
  });

  it("a token without a device id is still caught by the user marker", async () => {
    store.set(revokedUserKey(USER), { value: JSON.stringify({ at: Date.now() + 2000 }), ttl: ACCESS_TTL_SEC });
    authorization = await bearerFor("");
    const r = await requireTenant();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(await r.response.json()).toEqual({ error: "REVOKED" });
  });

  it("an unsigned / garbage bearer is plain 401 Unauthorized, never REVOKED", async () => {
    await markUserRevoked(USER);
    authorization = "Bearer not-a-jwt";
    const r = await requireTenant();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(401);
    expect(await r.response.json()).toEqual({ error: "Unauthorized" });
  });
});

describe("fail-open", () => {
  it("a cache read that throws does not lock the caller out", async () => {
    cacheGet.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    authorization = await bearerFor();
    const r = await requireTenant();
    expect(r.ok).toBe(true);
  });

  it("a cache read that answers null (lib/cache's own error path) passes too", async () => {
    cacheGet.mockImplementation(async () => null);
    await markUserRevoked(USER);
    authorization = await bearerFor();
    const r = await requireTenant();
    expect(r.ok).toBe(true);
  });

  it("a cache write that throws never surfaces to the revoking route", async () => {
    cacheSet.mockImplementation(async () => {
      throw new Error("READONLY");
    });
    await expect(markDevicesRevoked([DEVICE])).resolves.toBeUndefined();
    await expect(markUserRevoked(USER)).resolves.toBeUndefined();
    cacheSet.mockImplementation(async (key: string, value: unknown, ttl: number) => {
      store.set(key, { value: JSON.stringify(value), ttl });
    });
  });
});
