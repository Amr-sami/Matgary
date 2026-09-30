/**
 * Digital collections 05 §4.17 / §4.3 (step 4) — lib/api/auth-helpers.ts.
 *
 * 1. An ingest token (`Authorization: Bearer mgi_…`, 03 §E.1) grants exactly
 *    one power: posting messages to the ingest route. `resolveSession` refuses
 *    it BEFORE any JWT parse, and never falls back to a cookie session that
 *    happens to ride the same request. A normal JWT still reaches
 *    `verifyAccessToken`.
 * 2. `requirePermissionWithBranchEnforced` denies with 403 `Forbidden` even
 *    when PERMISSION_ENFORCE_WRITES is unset (production's audit mode), while
 *    the audited `requirePermissionWithBranch` lets the same caller through.
 *
 * next/headers, Auth.js, the cache and the branch resolver are faked; the
 * access token is a real signed one (AUTH_SECRET set here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Permission } from "@/lib/permissions";

process.env.AUTH_SECRET ??= "ingest-bearer-rejected-test-secret";

const C = vi.hoisted(() => ({
  USER: "11111111-1111-4111-8111-111111111111",
  DEVICE: "22222222-2222-4222-8222-222222222222",
  TENANT: "33333333-3333-4333-8333-333333333333",
  BRANCH: "44444444-4444-4444-8444-444444444444",
}));

const req = vi.hoisted(() => ({
  authorization: null as string | null,
  cookieSession: false,
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(req.authorization ? { authorization: req.authorization } : {}),
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("@/lib/auth", () => ({
  auth: async () =>
    req.cookieSession
      ? {
          user: {
            id: C.USER,
            tenantId: C.TENANT,
            role: "owner",
            permissions: [],
          },
        }
      : null,
  resolveTenantContext: async () => ({ tenantSuspendedReason: null }),
}));

vi.mock("@/lib/cache", () => ({
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => {}),
  cacheDel: vi.fn(async () => {}),
  cacheRemember: vi.fn(),
  cacheBustPrefix: vi.fn(async () => {}),
  cacheBustTenant: vi.fn(async () => {}),
  globalKey: (...parts: (string | number)[]) => ["g", ...parts.map(String)].join(":"),
  tenantKey: (t: string, ...parts: (string | number)[]) => ["t", t, ...parts.map(String)].join(":"),
}));

vi.mock("@/lib/api/branch-context", () => ({
  resolveActiveBranchResult: vi.fn(async () => ({
    ok: true,
    branch: {
      branchId: C.BRANCH,
      branchName: "Main",
      isPrimary: true,
      allowedBranchIds: [C.BRANCH],
    },
  })),
}));

// Spy on verifyAccessToken while keeping the real implementation.
const verifySpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/api/native-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/native-token")>();
  return {
    ...actual,
    verifyAccessToken: async (token: string) => {
      verifySpy.calls++;
      return actual.verifyAccessToken(token);
    },
  };
});

const { signAccessToken } = await import("@/lib/api/native-token");
const {
  requireTenant,
  requirePermissionWithBranch,
  requirePermissionWithBranchEnforced,
} = await import("@/lib/api/auth-helpers");

async function bearerFor(role: "owner" | "staff", permissions: Permission[] = []): Promise<string> {
  const token = await signAccessToken({
    sub: C.USER,
    tenantId: C.TENANT,
    role,
    permissions,
    tv: 1,
    did: C.DEVICE,
    susp: null,
    mcp: false,
    sub_ok: true,
  });
  return `Bearer ${token}`;
}

const MGI = "mgi_" + "A".repeat(43);

beforeEach(() => {
  req.authorization = null;
  req.cookieSession = false;
  verifySpy.calls = 0;
});

afterEach(() => {
  delete process.env.PERMISSION_ENFORCE_WRITES;
});

describe("resolveSession refuses collections ingest tokens (05 §4.17)", () => {
  it("mgi_ bearer → 401 Unauthorized, verifyAccessToken never called", async () => {
    req.authorization = `Bearer ${MGI}`;
    const r = await requireTenant();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(401);
    expect(await r.response.json()).toEqual({ error: "Unauthorized" });
    expect(verifySpy.calls).toBe(0);
  });

  it("mgi_ bearer is not downgraded to a cookie session on the same request", async () => {
    req.authorization = `Bearer ${MGI}`;
    req.cookieSession = true;
    const r = await requireTenant();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(401);
    expect(verifySpy.calls).toBe(0);
  });

  it("lower-case scheme (`bearer mgi_…`) is refused the same way", async () => {
    req.authorization = `bearer ${MGI}`;
    const r = await requireTenant();
    expect(r.ok).toBe(false);
    expect(verifySpy.calls).toBe(0);
  });

  it("a normal access token still goes through verifyAccessToken and passes", async () => {
    req.authorization = await bearerFor("owner");
    const r = await requireTenant();
    expect(verifySpy.calls).toBe(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ctx.userId).toBe(C.USER);
    expect(r.ctx.tenantId).toBe(C.TENANT);
  });

  it("a cookie session with no bearer is unchanged", async () => {
    req.cookieSession = true;
    const r = await requireTenant();
    expect(r.ok).toBe(true);
    expect(verifySpy.calls).toBe(0);
  });
});

describe("requirePermissionWithBranchEnforced (05 §4.3)", () => {
  it("staff without the key → 403 Forbidden even with PERMISSION_ENFORCE_WRITES unset", async () => {
    delete process.env.PERMISSION_ENFORCE_WRITES;
    req.authorization = await bearerFor("staff", ["record_sales"]);
    const r = await requirePermissionWithBranchEnforced("confirm_collections");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(403);
    expect(await r.response.json()).toEqual({ error: "Forbidden" });
  });

  it("the audited helper lets the same caller through in audit mode (contrast)", async () => {
    delete process.env.PERMISSION_ENFORCE_WRITES;
    req.authorization = await bearerFor("staff", ["record_sales"]);
    const r = await requirePermissionWithBranch("confirm_collections");
    expect(r.ok).toBe(true);
  });

  it("staff holding the key passes, with the branch context", async () => {
    req.authorization = await bearerFor("staff", ["confirm_collections"]);
    const r = await requirePermissionWithBranchEnforced("confirm_collections");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ctx.branchId).toBe(C.BRANCH);
  });

  it("the owner passes every key", async () => {
    req.authorization = await bearerFor("owner");
    for (const p of ["view_collections", "confirm_collections", "manage_collection_accounts"] as const) {
      const r = await requirePermissionWithBranchEnforced(p);
      expect(r.ok).toBe(true);
    }
  });

  it("an mgi_ bearer is 401 before any permission check", async () => {
    req.authorization = `Bearer ${MGI}`;
    const r = await requirePermissionWithBranchEnforced("view_collections");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(401);
  });
});
