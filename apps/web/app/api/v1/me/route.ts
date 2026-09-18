import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { tenants, users } from "@/lib/db/schema";
import { resolveTenantContext } from "@/lib/auth";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { listBranches } from "@/lib/repo/branches";
import { ALL_PERMISSIONS, type Permission } from "@/lib/permissions";

// GET /api/v1/me — the native client's bootstrap call.
//
// The mobile app fetches this once right after login and caches it for the
// life of the session: it is the only thing that knows which tabs to render,
// which branch the user is operating at, and which branches the branch picker
// may offer. Everything here is derivable from other endpoints, but a cold
// app start cannot afford four round-trips before it can draw a tab bar.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Expand a principal's raw grants into the list the client can actually test
 * with `permissions.includes(...)`.
 *
 * WHY this exists: lib/permissions.ts models owner access implicitly — `can()`
 * short-circuits on `role === "owner"` and never looks at the array, so an
 * owner's `tenant_members.permissions` row is legitimately EMPTY. On the web
 * that is invisible because every check goes through `can()`. A native client
 * has no `can()`; it renders its tab bar straight from this array, and an
 * empty array would give the store owner an app with nothing in it.
 *
 * DECISION: we expand server-side and ship the full catalogue for an owner,
 * rather than shipping the raw array and making the client branch on a flag.
 * The client then has exactly one rule — "is this string in `permissions`?" —
 * and stays correct if the owner short-circuit is ever narrowed. `isOwner` is
 * still returned alongside, but only as a label for owner-only *copy* (e.g.
 * "صاحب المتجر"); no capability decision should depend on it.
 */
function effectivePermissions(
  role: string | null,
  granted: Permission[],
): Permission[] {
  return role === "owner" ? [...ALL_PERMISSIONS] : granted;
}

export async function GET() {
  // requireTenantWithBranch also resolves the active branch (X-Branch-Id, then
  // the mg.branch cookie, then the user's primary) and validates it against
  // the user's allow-list, so `ctx.allowedBranchIds` below is already trusted.
  //
  // This is the ONE authenticated read that answers behind the
  // must-change-password and subscription walls. Every other route 403/402s
  // there; if this one did too, the native app could never seed a session and
  // the router would have nowhere to send the user — a new staff account or a
  // lapsed tenant would be stuck on the login screen forever (the web
  // equivalent: pages still render under those walls, only API calls fail).
  // The body says which wall applies so the client routes proactively.
  const r = await requireTenantWithBranch({
    allowPasswordChangeRequired: true,
    allowSubscriptionRequired: true,
  });
  if (!r.ok) return r.response;
  const { ctx } = r;
  const walls = new Set(ctx.walls ?? []);

  const [account, tenantRow, allBranches, userCtx] = await Promise.all([
    // users/tenants are not RLS-protected (they are the tables that establish
    // tenancy in the first place), so the plain client is correct here — and
    // neither id comes from the request body, both come from the verified
    // token claims.
    db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1),
    db
      .select({ slug: tenants.slug, name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId))
      .limit(1),
    // Reuse the cached repo read instead of re-querying branches: the active
    // branch resolver has usually just warmed it for this tenant.
    listBranches(ctx.tenantId),
    // Locale and subscription state are not in the access-token claims in a
    // form worth trusting for display, and this resolution is itself cached
    // for ~60s, so it is effectively free on a warm path.
    resolveTenantContext(ctx.userId),
  ]);

  // The user row is guaranteed by the token, but a hard-deleted account with a
  // still-valid 15-minute access token would land here. Fail closed.
  if (!account[0]) {
    return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 401 });
  }

  const allowed = new Set(ctx.allowedBranchIds);
  const switchable = allBranches
    // Inactive branches stay out of the picker: resolveActiveBranch refuses to
    // select one, so offering it would produce a switch that silently no-ops.
    .filter((b) => b.isActive && allowed.has(b.id))
    .map((b) => ({ id: b.id, name: b.name, isPrimary: b.isPrimary }));

  return NextResponse.json({
    user: {
      id: ctx.userId,
      email: account[0].email,
      name: account[0].name,
      role: ctx.role,
      locale: userCtx.locale,
      // Claim OR row: the claim is what gates every other request until the
      // next refresh, the row is what an admin reset flips first. Either one
      // means the app must land on /settings/change-password.
      mustChangePassword:
        walls.has("PASSWORD_CHANGE_REQUIRED") || userCtx.mustChangePassword,
    },
    tenant: {
      id: ctx.tenantId,
      slug: tenantRow[0]?.slug ?? userCtx.tenantSlug,
      name: tenantRow[0]?.name ?? null,
      subscriptionStatus: userCtx.subscriptionStatus,
      // Same rule as above: active only when BOTH the claim and the row agree.
      subscriptionAccessActive:
        userCtx.subscriptionAccessActive && !walls.has("SUBSCRIPTION_REQUIRED"),
      suspended: Boolean(userCtx.tenantSuspendedAt),
    },
    branch: {
      id: ctx.branchId,
      name: ctx.branchName,
      isPrimary: ctx.isPrimaryBranch,
    },
    branches: switchable,
    // Effective, already owner-expanded — see effectivePermissions above.
    permissions: effectivePermissions(ctx.role, ctx.permissions),
    isOwner: ctx.role === "owner",
    // Same flag the web session carries (session.user.onboardingComplete):
    // shop_settings.shopName is set, i.e. the wizard's Finish/Skip ran. The
    // app's soft gate reads it to offer "Finish setup" until it flips.
    onboardingComplete: userCtx.onboardingComplete,
  });
}
