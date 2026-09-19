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
  | { ok: false; response: NextResponse; reason?: "MUST_ROTATE" };

export interface RequireOptions {
  /** Let a session whose admin still carries `must_rotate` through. Only the
   *  handful of routes the rotation screen itself needs set this:
   *  auth/rotate-password, auth/logout and GET account. Everything else gets
   *  a 403 MUST_ROTATE — the same wall the /admin pages put up with their
   *  redirect to /admin/account/password?required=1 (doc 14 §10 B2). */
  allowMustRotate?: boolean;
}

function mustRotateResponse(): NextResponse {
  return NextResponse.json(
    { error: "MUST_ROTATE", redirectTo: "/admin/account/password?required=1" },
    { status: 403 },
  );
}

/** Resolve the admin session and return it. When there's no session, returns
 *  a hard 404 — the URL space stays invisible to non-admins (spec §2.5).
 *  When the admin must rotate their password, returns 403 MUST_ROTATE unless
 *  the caller opted in with `allowMustRotate`. */
export async function requireAdmin(opts: RequireOptions = {}): Promise<RequireResult> {
  const session = await resolveSessionFromCookies();
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  if (session.mustRotate && !opts.allowMustRotate) {
    return { ok: false, reason: "MUST_ROTATE", response: mustRotateResponse() };
  }
  return { ok: true, session };
}

export async function requireSuperAdmin(opts: RequireOptions = {}): Promise<RequireResult> {
  const r = await requireAdmin(opts);
  if (!r.ok) return r;
  if (r.session.adminRole !== "super_admin") {
    return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  return r;
}

export async function requirePermission(
  permission: AdminPermission,
  opts: RequireOptions = {},
): Promise<RequireResult> {
  const r = await requireAdmin(opts);
  if (!r.ok) return r;
  if (!roleHas(r.session.adminRole, permission)) {
    return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  return r;
}
