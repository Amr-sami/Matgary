import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { requirePermission } from "@/lib/api/auth-helpers";
import { resolveBranchFilter } from "@/lib/api/branch-context";
import {
  addTeamMember,
  listTeamMembers,
  TeamConflictError,
} from "@/lib/repo/team";
import { ALL_PERMISSIONS, type Permission } from "@/lib/permissions";
import { logActivity } from "@/lib/repo/activity";
import { withTenant } from "@/lib/db";
import { branches } from "@/lib/db/schema";

export async function GET(req: NextRequest) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const filter = await resolveBranchFilter(
    r.ctx,
    req.nextUrl.searchParams.get("branchId"),
  );
  if (!filter.ok) {
    return NextResponse.json({ error: filter.error }, { status: filter.status });
  }
  const data = await listTeamMembers(r.ctx.tenantId, filter.branchId);
  return NextResponse.json({ data, branchId: filter.branchId });
}

const createSchema = z.object({
  username: z.string().min(2).max(40),
  displayName: z.string().min(1).max(80),
  password: z.string().min(8).max(128),
  permissions: z
    .array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]))
    .default([]),
  phone: z.string().max(40).nullable().optional(),
  nationalId: z.string().max(40).nullable().optional(),
  address: z.string().max(255).nullable().optional(),
  profilePhotoPath: z.string().max(255).nullable().optional(),
  idPhotoPath: z.string().max(255).nullable().optional(),
  branchId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  // Multi-store: each staff member is locked to one branch. Validate the
  // branch exists in this tenant before insert — without this an attacker
  // who knows another tenant's branch UUID could attach their staff to it.
  const [branch] = await withTenant(r.ctx.tenantId, (tx) =>
    tx
      .select({ id: branches.id })
      .from(branches)
      .where(
        and(
          eq(branches.tenantId, r.ctx.tenantId),
          eq(branches.id, parsed.data.branchId),
        ),
      )
      .limit(1),
  );
  if (!branch) {
    return NextResponse.json({ error: "INVALID_BRANCH" }, { status: 400 });
  }

  try {
    const result = await addTeamMember(r.ctx.tenantId, parsed.data);
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "team.add",
      category: "team",
      entityType: "user",
      entityId: result.userId,
      entityLabel: parsed.data.displayName,
      branchId: parsed.data.branchId,
      metadata: {
        username: parsed.data.username,
        permissions: parsed.data.permissions,
      },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof TeamConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
