/**
 * Doc 14 §10 B2 (residual) — must_rotate is enforced on the API, not only
 * on the /admin pages.
 *
 * Every /admin page redirects a session whose admin carries must_rotate to
 * /admin/account/password?required=1. The /api/admin/* routes all open with
 * requireAdmin / requireSuperAdmin / requirePermission, which used to ignore
 * the flag — so the same cookie the pages bounce could still drive every
 * admin API. These pin the helpers (403 MUST_ROTATE unless the caller opts
 * in) and, from SOURCE, the exact three routes that opt in.
 *
 * The session resolver is mocked; no DB.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedAdminSession } from "@/lib/admin/session";

const resolveSessionFromCookies = vi.fn<() => Promise<ResolvedAdminSession | null>>();

vi.mock("@/lib/admin/session", () => ({
  resolveSessionFromCookies: () => resolveSessionFromCookies(),
}));

const { requireAdmin, requirePermission, requireSuperAdmin } = await import(
  "@/lib/admin/permissions"
);

function session(over: Partial<ResolvedAdminSession> = {}): ResolvedAdminSession {
  return {
    sessionId: "s1",
    adminId: "a1",
    adminEmail: "root@example.com",
    adminRole: "super_admin",
    mustRotate: false,
    displayName: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  };
}

beforeEach(() => {
  resolveSessionFromCookies.mockReset();
});

describe("requireAdmin", () => {
  it("404s with no session (URL space stays invisible)", async () => {
    resolveSessionFromCookies.mockResolvedValue(null);
    const r = await requireAdmin();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(404);
    expect(r.reason).toBeUndefined();
  });

  it("passes a clean session through", async () => {
    resolveSessionFromCookies.mockResolvedValue(session());
    const r = await requireAdmin();
    expect(r.ok).toBe(true);
  });

  it("403 MUST_ROTATE when the admin must rotate", async () => {
    resolveSessionFromCookies.mockResolvedValue(session({ mustRotate: true }));
    const r = await requireAdmin();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("MUST_ROTATE");
    expect(r.response.status).toBe(403);
    const body = await r.response.json();
    expect(body.error).toBe("MUST_ROTATE");
    expect(body.redirectTo).toBe("/admin/account/password?required=1");
  });

  it("lets a must-rotate session through with allowMustRotate", async () => {
    resolveSessionFromCookies.mockResolvedValue(session({ mustRotate: true }));
    const r = await requireAdmin({ allowMustRotate: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.mustRotate).toBe(true);
  });
});

describe("requireSuperAdmin / requirePermission inherit the gate", () => {
  it("requireSuperAdmin: MUST_ROTATE wins over the role check", async () => {
    resolveSessionFromCookies.mockResolvedValue(session({ mustRotate: true }));
    const r = await requireSuperAdmin();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("MUST_ROTATE");
    expect(r.response.status).toBe(403);
  });

  it("requireSuperAdmin: still 404s a non-super admin", async () => {
    resolveSessionFromCookies.mockResolvedValue(session({ adminRole: "ops_admin" }));
    const r = await requireSuperAdmin();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(404);
  });

  it("requirePermission: MUST_ROTATE even for a permission the role holds", async () => {
    resolveSessionFromCookies.mockResolvedValue(session({ mustRotate: true }));
    const r = await requirePermission("tenant.read");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("MUST_ROTATE");
  });

  it("requirePermission: opts pass through", async () => {
    resolveSessionFromCookies.mockResolvedValue(session({ mustRotate: true }));
    const r = await requirePermission("tenant.read", { allowMustRotate: true });
    expect(r.ok).toBe(true);
  });

  it("requirePermission: a clean ops_admin still cannot admin.manage", async () => {
    resolveSessionFromCookies.mockResolvedValue(session({ adminRole: "ops_admin" }));
    const r = await requirePermission("admin.manage");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(404);
  });
});

/** Pinned from SOURCE (see route-gates.test.ts for why): exactly these
 *  handlers opt out of the rotation wall, and no other admin route does. */
describe("allowMustRotate allowlist", () => {
  const src = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../app/api/admin/${rel}/route.ts`, import.meta.url)), "utf8");

  it("rotate-password, logout and GET account opt in", () => {
    expect(src("auth/rotate-password")).toContain("requireAdmin({ allowMustRotate: true })");
    expect(src("auth/logout")).toContain("requireAdmin({ allowMustRotate: true })");
    const account = src("account");
    const getBody = account.slice(account.indexOf("export async function GET"), account.indexOf("export async function PATCH"));
    const patchBody = account.slice(account.indexOf("export async function PATCH"));
    expect(getBody).toContain("requireAdmin({ allowMustRotate: true })");
    expect(patchBody).toContain("requireAdmin()");
    expect(patchBody).not.toContain("allowMustRotate");
  });

  it("no other admin route opts in", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = fileURLToPath(new URL("../../app/api/admin", import.meta.url));
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name === "route.ts") routes.push(p);
      }
    };
    walk(root);
    expect(routes.length).toBeGreaterThan(5);
    const optedIn = routes
      .filter((p) => readFileSync(p, "utf8").includes("allowMustRotate"))
      .map((p) => p.slice(root.length + 1).replace(/\/route\.ts$/, ""))
      .sort();
    expect(optedIn).toEqual(["account", "auth/logout", "auth/rotate-password"]);
  });
});
