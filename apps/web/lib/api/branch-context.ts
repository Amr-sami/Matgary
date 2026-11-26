import { and, asc, desc, eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { branches } from "@/lib/db/schema";
import { cacheRemember, globalKey } from "@/lib/cache";
import { withSpan } from "@/lib/observability/tracing";

// Branch has been removed from Storo as a product concept — there is no
// user-facing branch UI, no switching, no per-branch filters. The legacy
// `branches` table + `branch_id` columns on ~25 tables remain as DB residue
// so historical data stays intact, but at the application layer every call
// collapses to the tenant's SINGLE active branch (seeded on signup as the
// "primary" branch).
//
// This file is now the single source of truth for that collapse:
//
//   - `resolveActiveBranch*` always returns the primary branch, ignoring any
//     `X-Branch-Id` header or `mg.branch` cookie the client may still send.
//     Existing route handlers that still call `requireTenantWithBranch`
//     continue to work unchanged — they just always get the primary branch.
//   - `getAccessibleBranches` returns `[primaryBranchId]`. The old per-staff
//     branch allow-list is dead code.
//   - `resolveBranchFilter` honours only "all" (owner-only) vs single-branch;
//     any specific branch id passed is treated as "my branch".
//
// The cookie name is kept as a constant for one reason: a session logging in
// with an old cookie value needs us to NOT crash. We never read it.

export const ACTIVE_BRANCH_COOKIE = "mg.branch";

export interface BranchContext {
  branchId: string;
  branchName: string;
  isPrimary: boolean;
  /** Every branch the current user is allowed to switch to. */
  allowedBranchIds: string[];
}

/**
 * Outcome of resolving the active branch, with the failure typed so a caller
 * can answer the client precisely instead of collapsing every miss to null.
 *
 *   - INVALID_BRANCH (400): the request named a branch through `X-Branch-Id`
 *     that cannot be served — not a UUID, not on the caller's allow-list, or
 *     no longer active. Only the header transport (the native app) gets this;
 *     see resolveActiveBranchImpl for why the cookie keeps its fallback.
 *   - NO_BRANCH_ACCESS (403): the caller can reach no active branch at all.
 *
 * `resolveActiveBranch` is the legacy `BranchContext | null` view of the same
 * result — both failures become null there, which its callers already answer
 * with 403 NO_BRANCH_ACCESS. Switch a caller to this function to send the
 * 400 body the native client keys on.
 */
export type ActiveBranchResult =
  | { ok: true; branch: BranchContext }
  | { ok: false; status: 400; error: "INVALID_BRANCH"; branchId: string }
  | { ok: false; status: 403; error: "NO_BRANCH_ACCESS" };

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
 * Legacy — previously returned the per-staff branch allow-list. With branches
 * removed from the product, every user has access to exactly one branch: the
 * tenant's primary. Kept callable for the two or three routes that read this
 * list; the single-element array stands in cleanly.
 */
export async function getAccessibleBranches(
  ctx: ResolveInput,
): Promise<string[]> {
  return cacheRemember(
    allowedCacheKey(ctx.tenantId, ctx.userId),
    ALLOWED_TTL_SEC,
    async () => {
      const id = await getPrimaryBranchId(ctx.tenantId);
      return id ? [id] : [];
    },
  );
}

/**
 * Resolve the tenant's one active branch — the primary seeded on signup.
 * Cached per tenant for the full process lifetime (primary doesn't change
 * after creation; the invariant is enforced in `lib/repo/branches.ts`).
 */
const PRIMARY_CACHE = new Map<string, Promise<string | null>>();

export async function getPrimaryBranchId(tenantId: string): Promise<string | null> {
  const cached = PRIMARY_CACHE.get(tenantId);
  if (cached) return cached;
  const promise = withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, tenantId), eq(branches.isActive, true)))
      .orderBy(desc(branches.isPrimary), asc(branches.createdAt))
      .limit(1);
    return row?.id ?? null;
  });
  PRIMARY_CACHE.set(tenantId, promise);
  try {
    return await promise;
  } catch (err) {
    // Transient DB error — don't poison the cache.
    PRIMARY_CACHE.delete(tenantId);
    throw err;
  }
}

/**
 * Resolve the active branch for the current request. Honours the `mg.branch`
 * cookie when it points to an accessible, active branch; otherwise falls
 * back to the user's primary (or first available) branch. An `X-Branch-Id`
 * header is honoured or refused, never substituted — see
 * resolveActiveBranchResult.
 *
 * Returns null when the branch cannot be resolved: the tenant has no active
 * branch the user can reach (a misconfigured staff row), or the header named
 * a branch that cannot be served. Every signed-in caller in a normal flow
 * gets a valid context because the migration seeds a primary branch per
 * tenant. Callers that want to tell the two apart use
 * resolveActiveBranchResult.
 */
export async function resolveActiveBranch(
  ctx: ResolveInput,
): Promise<BranchContext | null> {
  const r = await resolveActiveBranchResult(ctx);
  return r.ok ? r.branch : null;
}

/**
 * resolveActiveBranch with the failure kept: 400 INVALID_BRANCH for a header
 * that names an unservable branch, 403 NO_BRANCH_ACCESS for a caller with no
 * reachable branch. The shape mirrors resolveBranchFilter's, so a route
 * answers `NextResponse.json({ error }, { status })` for either.
 */
export async function resolveActiveBranchResult(
  ctx: ResolveInput,
): Promise<ActiveBranchResult> {
  return withSpan(
    "api.branch.resolve_active",
    {
      "matgary.tenant_id": ctx.tenantId,
      "matgary.user_id": ctx.userId,
    },
    () => resolveActiveBranchImpl(ctx),
  );
}

/**
 * Always resolves to the tenant's primary branch. Branch switching is gone
 * from the product — the client may still send `X-Branch-Id` or `mg.branch`
 * (old apps in the wild, legacy tests), and we silently ignore both.
 *
 * Failure paths left in place:
 *   - 403 NO_BRANCH_ACCESS: a tenant with zero active branches (pathological;
 *     the signup flow seeds one, so this is "the branches table was cleared
 *     out of band" territory).
 *
 * The 400 INVALID_BRANCH code is no longer returned. Nothing can "ask for" a
 * branch anymore, so there is no bad-ask to refuse.
 */
async function resolveActiveBranchImpl(
  ctx: ResolveInput,
): Promise<ActiveBranchResult> {
  const id = await getPrimaryBranchId(ctx.tenantId);
  if (!id) return { ok: false, status: 403, error: "NO_BRANCH_ACCESS" };
  return withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: branches.id,
        name: branches.name,
        isPrimary: branches.isPrimary,
      })
      .from(branches)
      .where(and(eq(branches.id, id), eq(branches.tenantId, ctx.tenantId)))
      .limit(1);
    if (!row) return { ok: false, status: 403, error: "NO_BRANCH_ACCESS" };
    return {
      ok: true,
      branch: {
        branchId: row.id,
        branchName: row.name,
        isPrimary: row.isPrimary,
        allowedBranchIds: [row.id],
      },
    };
  });
}

/**
 * Legacy — list endpoints used to accept `?branchId=all|<uuid>` for the
 * owner's cross-branch view. With branches gone, every call collapses to
 * the tenant's primary branch regardless of what the client sends. The
 * previous codes (ALL_BRANCHES_OWNER_ONLY / FORBIDDEN_BRANCH) are no longer
 * returned because they have no meaning in a single-branch world.
 */
export async function resolveBranchFilter(
  ctx: ResolveInput,
  _raw: string | null,
): Promise<
  | { ok: true; branchId: string | null }
  | { ok: false; status: number; error: string }
> {
  const active = await resolveActiveBranchResult(ctx);
  if (!active.ok) {
    return { ok: false, status: active.status, error: active.error };
  }
  return { ok: true, branchId: active.branch.branchId };
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
