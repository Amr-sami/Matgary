import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  addTeamMember,
  listTeamMembers,
  TeamConflictError,
} from "@/lib/repo/team";
import { ALL_PERMISSIONS, type Permission } from "@/lib/permissions";

export async function GET() {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const data = await listTeamMembers(r.ctx.tenantId);
  return NextResponse.json({ data });
}

const createSchema = z.object({
  username: z.string().min(2).max(40),
  displayName: z.string().min(1).max(80),
  password: z.string().min(8).max(128),
  permissions: z
    .array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]))
    .default([]),
});

export async function POST(req: NextRequest) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  try {
    const result = await addTeamMember(r.ctx.tenantId, parsed.data);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof TeamConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
