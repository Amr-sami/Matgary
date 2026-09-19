import { cookies, headers } from "next/headers";
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveActiveBranchImpl(
  ctx: ResolveInput,
): Promise<ActiveBranchResult> {
  const allowedBranchIds = await getAccessibleBranches(ctx);
  if (allowedBranchIds.length === 0) {
    return { ok: false, status: 403, error: "NO_BRANCH_ACCESS" };
  }

  // Branch selection has two transports, in priority order:
  //
  //   1. `X-Branch-Id` request header — per-request, and the only option for a
  //      client that has no cookie jar. A native app sends it on every call, so
  //      two screens can look at two branches without fighting over one global
  //      session value.
  //   2. `mg.branch` HttpOnly cookie — what the web app has always used, and
  //      still the fallback when no header is present.
  //
  // Both are validated against the SAME allow-list below, so the header grants
  // no authority the cookie did not already have. What differs is the answer
  // to a miss:
  //
  //   - The cookie is a remembered preference. A stale or tampered value falls
  //     through to the user's primary branch, as it always has — the web app
  //     never asked for a specific branch on this request.
  //   - The header is an explicit, per-request choice. Serving another branch
  //     under it would hand the client rows it did not ask for, labelled as
  //     the branch it did (doc 14 §5.3: a zero UUID answered 200 with primary
  //     data). So a header that is not a UUID, not on the allow-list, or
  //     names an inactive branch is refused with INVALID_BRANCH instead. The
  //     web (cookie) path is unchanged: it never sends the header.
  const headerStore = await headers();
  const headerValue = headerStore.get("x-branch-id")?.trim() || null;
  const cookieStore = await cookies();
  const requested =
    headerValue ?? cookieStore.get(ACTIVE_BRANCH_COOKIE)?.value ?? null;
  const strict = headerValue !== null;

  if (
    strict &&
    (!UUID_RE.test(headerValue) || !allowedBranchIds.includes(headerValue))
  ) {
    return {
      ok: false,
      status: 400,
      error: "INVALID_BRANCH",
      branchId: headerValue,
    };
  }

  return withTenant(ctx.tenantId, async (tx) => {
    // First try the explicitly requested branch (header, else cookie).
    if (requested && allowedBranchIds.includes(requested)) {
      const [b] = await tx
        .select({
          id: branches.id,
          name: branches.name,
          isPrimary: branches.isPrimary,
        })
        .from(branches)
        .where(
          and(
            eq(branches.id, requested),
            eq(branches.tenantId, ctx.tenantId),
            eq(branches.isActive, true),
          ),
        )
        .limit(1);
      if (b) {
        return {
          ok: true,
          branch: {
            branchId: b.id,
            branchName: b.name,
            isPrimary: b.isPrimary,
            allowedBranchIds,
          },
        };
      }
      // On the allow-list but no longer active. The header asked for it by
      // name, so it gets the refusal rather than a quiet swap to primary.
      if (strict) {
        return {
          ok: false,
          status: 400,
          error: "INVALID_BRANCH",
          branchId: requested,
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
    if (!first) return { ok: false, status: 403, error: "NO_BRANCH_ACCESS" };
    return {
      ok: true,
      branch: {
        branchId: first.id,
        branchName: first.name,
        isPrimary: first.isPrimary,
        allowedBranchIds,
      },
    };
  });
}

/**
 * Resolve the read-side branch filter for a list endpoint, given the raw
 * `?branchId=` query value. Centralised so every list route handles the
 * three cases identically:
 *   - "all" → owner-only; returns null (no filter).
 *   - <uuid> → must be in the user's allow-list.
 *   - omitted → default to the active branch (X-Branch-Id header, else the
 *     cookie); an unservable header is 400 INVALID_BRANCH and a caller with
 *     no reachable branch is 403 NO_BRANCH_ACCESS, never "all".
 *
 * Returns either the resolved branch id (or null for "all"), or the status +
 * error code for the caller to return immediately.
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
  // Omitted: the active branch. A miss is answered, not widened — `null`
  // here would mean "every branch", which is exactly the read the caller
  // has no claim to (an unservable X-Branch-Id, or a staff row with no
  // branch at all).
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
