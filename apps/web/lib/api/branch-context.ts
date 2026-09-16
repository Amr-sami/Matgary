import { cookies } from "next/headers";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { branches, tenantMembers } from "@/lib/db/schema";
import { cacheRemember, globalKey } from "@/lib/cache";
import { withSpan } from "@/lib/observability/tracing";

// Active-branch session model.
//
// Once a tenant has more than one branch, every page render and every
// branch-scoped write needs to know "which branch is the user currently
// operating at". We persist that decision in a plain HttpOnly cookie
// (`mg.branch`). The cookie is *not* signed — it carries a UUID, not a
// secret, and the server validates it against the user's allow-list on every
// read. A tampered cookie just falls back to the user's primary branch.
//
// Access rules:
//   - Owners implicitly have access to every branch in their tenant. They
//     don't need an entry in tenant_members.branch_ids.
//   - Staff are restricted to the branches listed in tenant_members.branch_ids
//     on their tenant_members row. Empty list = no branch access (default
//     deny). The migration backfilled existing staff with the primary
//     branch so legacy logins keep working.

export const ACTIVE_BRANCH_COOKIE = "mg.branch";

export interface BranchContext {
  branchId: string;
  branchName: string;
  isPrimary: boolean;
  /** Every branch the current user is allowed to switch to. */
  allowedBranchIds: string[];
}

interface ResolveInput {
  tenantId: string;
  userId: string;
  role: string | null;
}

const ALLOWED_TTL_SEC = 60;

function allowedCacheKey(tenantId: string, userId: string): string {
  return globalKey("branch-allow", tenantId, userId);
}

/**
 * Drop the cached allow-list for one user. Call from any mutation that
 * changes branch membership: branch create/delete, staff add/update, role
 * change, etc.
 */
export async function bustBranchAllowListCache(
  tenantId: string,
  userId: string,
): Promise<void> {
  // Note: cacheBustPrefix would be heavier — we know the exact key.
  const { cacheDel } = await import("@/lib/cache");
  await cacheDel(allowedCacheKey(tenantId, userId));
}

/**
 * Resolve the list of branch ids this user can access.
 *  - Owner: every branch in their tenant (implicit access).
 *  - Staff: exactly one — the `branch_id` on their tenant_members row.
 *    Multi-store: each staff member is locked to one branch.
 *
 * Cached 60s per (tenant, user) so a busy POS terminal doesn't re-walk the
 * branches table on every keystroke.
 */
export async function getAccessibleBranches(
  ctx: ResolveInput,
): Promise<string[]> {
  return cacheRemember(
    allowedCacheKey(ctx.tenantId, ctx.userId),
    ALLOWED_TTL_SEC,
    async () => {
      if (ctx.role === "owner") {
        // RLS-protected: branches lookup goes through withTenant.
        return withTenant(ctx.tenantId, async (tx) => {
          const rows = await tx
            .select({ id: branches.id })
            .from(branches)
            .where(eq(branches.tenantId, ctx.tenantId));
          return rows.map((r) => r.id);
        });
      }
      // Staff: read the single branch from tenant_members. tenant_members is
      // not RLS-protected (it's the join table the app uses to even know
      // which tenant the user belongs to), so we hit it on the plain client.
      const [member] = await db
        .select({ branchId: tenantMembers.branchId })
        .from(tenantMembers)
        .where(
          and(
            eq(tenantMembers.tenantId, ctx.tenantId),
            eq(tenantMembers.userId, ctx.userId),
          ),
        )
        .limit(1);
      return member?.branchId ? [member.branchId] : [];
    },
  );
}

/**
 * Resolve the active branch for the current request. Honours the `mg.branch`
 * cookie when it points to an accessible, active branch; otherwise falls
 * back to the user's primary (or first available) branch.
 *
 * Returns null only when the tenant has no active branches at all the user
 * can reach — every signed-in caller in a normal flow gets a valid context
 * because the migration seeds a primary branch per tenant.
 */
export async function resolveActiveBranch(
  ctx: ResolveInput,
): Promise<BranchContext | null> {
  return withSpan(
    "api.branch.resolve_active",
    {
      "matgary.tenant_id": ctx.tenantId,
      "matgary.user_id": ctx.userId,
    },
    () => resolveActiveBranchImpl(ctx),
  );
}

async function resolveActiveBranchImpl(
  ctx: ResolveInput,
): Promise<BranchContext | null> {
  const allowedBranchIds = await getAccessibleBranches(ctx);
  if (allowedBranchIds.length === 0) return null;

  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(ACTIVE_BRANCH_COOKIE)?.value ?? null;

  return withTenant(ctx.tenantId, async (tx) => {
    // First try the cookie pick.
    if (cookieValue && allowedBranchIds.includes(cookieValue)) {
      const [b] = await tx
        .select({
          id: branches.id,
          name: branches.name,
          isPrimary: branches.isPrimary,
        })
        .from(branches)
        .where(
          and(
            eq(branches.id, cookieValue),
            eq(branches.tenantId, ctx.tenantId),
            eq(branches.isActive, true),
          ),
        )
        .limit(1);
      if (b) {
        return {
          branchId: b.id,
          branchName: b.name,
          isPrimary: b.isPrimary,
          allowedBranchIds,
        };
      }
    }

    // Fallback: user's primary (or first active).
    const [first] = await tx
      .select({
        id: branches.id,
        name: branches.name,
        isPrimary: branches.isPrimary,
      })
      .from(branches)
      .where(
        and(
          eq(branches.tenantId, ctx.tenantId),
          inArray(branches.id, allowedBranchIds),
          eq(branches.isActive, true),
        ),
      )
      .orderBy(desc(branches.isPrimary), asc(branches.createdAt))
      .limit(1);
    if (!first) return null;
    return {
      branchId: first.id,
      branchName: first.name,
      isPrimary: first.isPrimary,
      allowedBranchIds,
    };
  });
}

/**
 * Resolve the read-side branch filter for a list endpoint, given the raw
 * `?branchId=` query value. Centralised so every list route handles the
 * three cases identically:
 *   - "all" → owner-only; returns null (no filter).
 *   - <uuid> → must be in the user's allow-list.
 *   - omitted → default to the active branch (cookie context).
 *
 * Returns either the resolved branch id (or null for "all"), or a NextResponse
 * for the caller to return immediately.
 */
export async function resolveBranchFilter(
  ctx: ResolveInput,
  raw: string | null,
): Promise<
  | { ok: true; branchId: string | null }
  | { ok: false; status: number; error: string }
> {
  if (raw === "all") {
    if (ctx.role !== "owner") {
      return {
        ok: false,
        status: 403,
        error: "ALL_BRANCHES_OWNER_ONLY",
      };
    }
    return { ok: true, branchId: null };
  }
  if (raw) {
    const allowed = await getAccessibleBranches(ctx);
    if (!allowed.includes(raw)) {
      return { ok: false, status: 403, error: "FORBIDDEN_BRANCH" };
    }
    return { ok: true, branchId: raw };
  }
  const active = await resolveActiveBranch(ctx);
  return { ok: true, branchId: active?.branchId ?? null };
}

/**
 * Cookie attributes used when the /api/branches/select endpoint flips the
 * active branch. Centralised so any future change (sameSite, secure flag,
 * lifetime) lives in one place.
 */
export function activeBranchCookieAttributes(): {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // `Secure` is sensible behind HTTPS in prod. Disable in non-https dev so
    // the cookie sticks on http://localhost.
    secure: process.env.NODE_ENV === "production",
    // 90 days — POS terminals stay on one branch indefinitely.
    maxAge: 60 * 60 * 24 * 90,
  };
}
