import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  removeTeamMember,
  TeamConflictError,
  updateMemberPermissions,
} from "@/lib/repo/team";
import { ALL_PERMISSIONS, type Permission } from "@/lib/permissions";
import { logActivity } from "@/lib/repo/activity";
import { bustUserContextCache } from "@/lib/auth";
import { bustBranchAllowListCache } from "@/lib/api/branch-context";
import { withTenant } from "@/lib/db";
import { branches } from "@/lib/db/schema";

const patchSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  permissions: z
    .array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]))
    .optional(),
  phone: z.string().max(40).nullable().optional(),
  nationalId: z.string().max(40).nullable().optional(),
  address: z.string().max(255).nullable().optional(),
  profilePhotoPath: z.string().max(255).nullable().optional(),
  idPhotoPath: z.string().max(255).nullable().optional(),
  branchId: z.string().uuid().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const { userId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  // Multi-store: if the staff member is being moved to a different branch,
  // validate that branch belongs to this tenant — without this an attacker
  // who knows another tenant's branch UUID could attach their staff to it.
  if (parsed.data.branchId) {
    const [b] = await withTenant(r.ctx.tenantId, (tx) =>
      tx
        .select({ id: branches.id })
        .from(branches)
        .where(
          and(
            eq(branches.tenantId, r.ctx.tenantId),
            eq(branches.id, parsed.data.branchId!),
          ),
        )
        .limit(1),
    );
    if (!b) {
      return NextResponse.json({ error: "INVALID_BRANCH" }, { status: 400 });
    }
  }

  try {
    await updateMemberPermissions(r.ctx.tenantId, userId, parsed.data);
    await bustUserContextCache(userId);
    if (parsed.data.branchId !== undefined) {
      await bustBranchAllowListCache(r.ctx.tenantId, userId);
    }
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "team.update",
      category: "team",
      entityType: "user",
      entityId: userId,
      entityLabel: parsed.data.displayName ?? null,
      metadata: { changed: Object.keys(parsed.data) },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TeamConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const { userId } = await params;
  try {
    await removeTeamMember(r.ctx.tenantId, userId);
    await bustUserContextCache(userId);
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "team.delete",
      category: "team",
      entityType: "user",
      entityId: userId,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TeamConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
