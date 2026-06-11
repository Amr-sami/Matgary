// Admin role catalog + guards used by every /api/admin/* route.
//
// Two roles in v1: super_admin (all powers) and ops_admin (read-only on
// tenants + extend-trial; no admin mgmt, no plan edits, no impersonation).

import { NextResponse } from "next/server";
import { resolveSessionFromCookies, type ResolvedAdminSession } from "./session";

export type AdminRole = "super_admin" | "ops_admin";

export type AdminPermission =
  | "tenant.read"
  | "tenant.suspend"
  | "tenant.extend_trial"
  | "tenant.impersonate"
  | "plan.read"
  | "plan.update"
  | "admin.read"
  | "admin.manage"
  | "broadcast.read"
  | "broadcast.manage"
  | "audit.read";

const SUPER_ADMIN_PERMS = new Set<AdminPermission>([
  "tenant.read",
  "tenant.suspend",
  "tenant.extend_trial",
  "tenant.impersonate",
  "plan.read",
  "plan.update",
  "admin.read",
  "admin.manage",
  "broadcast.read",
  "broadcast.manage",
  "audit.read",
]);

const OPS_ADMIN_PERMS = new Set<AdminPermission>([
  "tenant.read",
  "tenant.extend_trial",
  "plan.read",
  "broadcast.read",
  "audit.read",
]);

export function roleHas(role: AdminRole, permission: AdminPermission): boolean {
  return (role === "super_admin" ? SUPER_ADMIN_PERMS : OPS_ADMIN_PERMS).has(permission);
}

export type RequireResult =
  | { ok: true; session: ResolvedAdminSession }
  | { ok: false; response: NextResponse };

/** Resolve the admin session and return it. When there's no session, returns
 *  a hard 404 — the URL space stays invisible to non-admins (spec §2.5). */
export async function requireAdmin(): Promise<RequireResult> {
  const session = await resolveSessionFromCookies();
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  return { ok: true, session };
}

export async function requireSuperAdmin(): Promise<RequireResult> {
  const r = await requireAdmin();
  if (!r.ok) return r;
  if (r.session.adminRole !== "super_admin") {
    return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  return r;
}

export async function requirePermission(
  permission: AdminPermission,
): Promise<RequireResult> {
  const r = await requireAdmin();
  if (!r.ok) return r;
  if (!roleHas(r.session.adminRole, permission)) {
    return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  return r;
}
