import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { cookies } from "next/headers";
import { eq, and } from "drizzle-orm";
import { requireTenant } from "@/lib/api/auth-helpers";
import {
  ACTIVE_BRANCH_COOKIE,
  activeBranchCookieAttributes,
  getAccessibleBranches,
} from "@/lib/api/branch-context";
import { withTenant } from "@/lib/db";
import { branches } from "@/lib/db/schema";
import { logActivity } from "@/lib/repo/activity";

// Switch the active branch. Validates:
//   - the requested branch belongs to the caller's tenant,
//   - the branch is active (not soft-disabled),
//   - the caller is allowed to access it (owner: implicit, staff:
//     tenant_members.branch_ids must include it).
//
// On success sets the `mg.branch` HttpOnly cookie that
// `requireTenantWithBranch()` reads on every subsequent request.

export const runtime = "nodejs";

const schema = z.object({
  branchId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }
  const { branchId } = parsed.data;

  // Validate access. We do this in two steps so the failure mode is the same
  // whether the branch doesn't exist, isn't in the tenant, or the staff
  // member doesn't have it on their allow-list — an attacker scanning UUIDs
  // shouldn't learn which case they hit.
  const allowed = await getAccessibleBranches(r.ctx);
  if (!allowed.includes(branchId)) {
    return NextResponse.json({ error: "FORBIDDEN_BRANCH" }, { status: 403 });
  }

  const [branch] = await withTenant(r.ctx.tenantId, (tx) =>
    tx
      .select({
        id: branches.id,
        name: branches.name,
        isActive: branches.isActive,
      })
      .from(branches)
      .where(
        and(
          eq(branches.tenantId, r.ctx.tenantId),
          eq(branches.id, branchId),
        ),
      )
      .limit(1),
  );
  if (!branch || !branch.isActive) {
    return NextResponse.json({ error: "FORBIDDEN_BRANCH" }, { status: 403 });
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_BRANCH_COOKIE, branchId, activeBranchCookieAttributes());

  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "branch.switch",
    category: "settings",
    entityType: "branch",
    entityId: branch.id,
    entityLabel: branch.name,
    branchId: branch.id,
  });

  return NextResponse.json({
    ok: true,
    branch: { id: branch.id, name: branch.name },
  });
}
