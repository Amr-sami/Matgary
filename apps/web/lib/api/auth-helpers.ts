import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import type { Permission } from "@/lib/permissions";
import { can } from "@/lib/permissions";
import {
  enterRequestContext,
  getRequestContext,
  setRequestContext,
} from "@/lib/request-context";
import {
  resolveActiveBranch,
  type BranchContext,
} from "./branch-context";

/**
 * Ensure the in-flight request has an AsyncLocalStorage context. The
 * middleware stamps `x-request-id` on the request headers; if no context
 * is already active for this async-boundary, we open one with `enterWith`
 * so every downstream await in the same handler sees the same request id.
 *
 * Idempotent — `requireTenant` (called by every route) invokes this, and
 * `requireTenantWithBranch` / `requirePermission` re-call without re-entry.
 */
async function ensureRequestContext(
  patch?: Partial<{ tenantId: string; userId: string }>,
): Promise<void> {
  const existing = getRequestContext();
  if (existing) {
    if (patch) setRequestContext(patch);
    return;
  }
  let reqId: string | null = null;
  try {
    const h = await headers();
    reqId = h.get("x-request-id");
  } catch {
    reqId = null;
  }
  enterRequestContext({
    requestId: reqId || crypto.randomUUID(),
    ...(patch ?? {}),
  });
}

export type AuthedContext = {
  userId: string;
  tenantId: string;
  role: string | null;
  permissions: Permission[];
};

export type AuthedBranchContext = AuthedContext & {
  branchId: string;
  branchName: string;
  isPrimaryBranch: boolean;
  /** Every branch this user can switch to right now. Useful for sending the
   *  current allow-list back to the client without an extra round-trip. */
  allowedBranchIds: string[];
};

/** Resolve session and require an authenticated user with a tenant. */
export async function requireTenant(): Promise<
  | { ok: true; ctx: AuthedContext }
  | { ok: false; response: NextResponse }
> {
  // Open the per-request ALS scope so every downstream log line carries
  // the request id (+ tenantId/userId once we know them).
  await ensureRequestContext();
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  setRequestContext({
    tenantId: session.user.tenantId,
    userId: session.user.id,
  });
  return {
    ok: true,
    ctx: {
      userId: session.user.id,
      tenantId: session.user.tenantId,
      role: session.user.role,
      permissions: (session.user.permissions ?? []) as Permission[],
    },
  };
}

/**
 * Require a logged-in user with at least one of the given permissions.
 * Owner role bypasses the check (owns everything in their tenant).
 */
export async function requirePermission(perm: Permission): Promise<
  | { ok: true; ctx: AuthedContext }
  | { ok: false; response: NextResponse }
> {
  const auth = await requireTenant();
  if (!auth.ok) return auth;
  if (!can(auth.ctx, perm)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return auth;
}

/**
 * Like `requireTenant`, but also resolves the active branch from the
 * `mg.branch` cookie (with primary-branch fallback). Use this for any
 * route that records or reads branch-scoped data — sales, expenses,
 * attendance, per-branch inventory.
 *
 * Returns 403 NO_BRANCH_ACCESS only when the user genuinely has zero
 * accessible branches (a misconfigured staff row); the migration guarantees
 * every tenant has a primary branch, so owners never hit this.
 */
export async function requireTenantWithBranch(): Promise<
  | { ok: true; ctx: AuthedBranchContext }
  | { ok: false; response: NextResponse }
> {
  const r = await requireTenant();
  if (!r.ok) return r;
  const branch = await resolveActiveBranch(r.ctx);
  if (!branch) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "NO_BRANCH_ACCESS" },
        { status: 403 },
      ),
    };
  }
  return {
    ok: true,
    ctx: {
      ...r.ctx,
      branchId: branch.branchId,
      branchName: branch.branchName,
      isPrimaryBranch: branch.isPrimary,
      allowedBranchIds: branch.allowedBranchIds,
    },
  };
}

export type { BranchContext };
