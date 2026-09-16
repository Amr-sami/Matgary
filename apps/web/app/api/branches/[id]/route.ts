import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import {
  BranchInUseError,
  BranchPrimaryError,
  deleteBranch,
  getBranch,
  updateBranch,
} from "@/lib/repo/branches";
import { logActivity } from "@/lib/repo/activity";

export const runtime = "nodejs";

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  address: z.string().max(200).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  isActive: z.boolean().optional(),
});

const idSchema = z.string().uuid();

interface Params {
  params: Promise<{ id: string }>;
}

const FORBIDDEN = NextResponse.json(
  { error: "العملية متاحة لصاحب المتجر فقط." },
  { status: 403 },
);

export async function GET(_req: NextRequest, { params }: Params) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const branch = await getBranch(r.ctx.tenantId, parsed.data);
  if (!branch) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ data: branch });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  if (r.ctx.role !== "owner") return FORBIDDEN;
  const { id } = await params;
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "بيانات غير صالحة" },
      { status: 400 },
    );
  }

  // Pull the prior state so we can log a clean before/after for any
  // human-meaningful field. Skipping when nothing changed avoids noise.
  const before = await getBranch(r.ctx.tenantId, idParsed.data);
  if (!before) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    await updateBranch(r.ctx.tenantId, idParsed.data, parsed.data);
  } catch (err) {
    if (err instanceof BranchPrimaryError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // Activity log: choose action based on what changed.
  let action = "branch.update";
  if (parsed.data.isActive === false) action = "branch.disable";
  else if (parsed.data.isActive === true && !before.isActive) action = "branch.enable";
  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action,
    category: "settings",
    entityType: "branch",
    entityId: before.id,
    entityLabel: parsed.data.name ?? before.name,
    branchId: before.id,
    metadata: parsed.data as Record<string, unknown>,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  if (r.ctx.role !== "owner") return FORBIDDEN;
  const { id } = await params;
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const before = await getBranch(r.ctx.tenantId, parsed.data);
  if (!before) {
    return NextResponse.json({ ok: true });
  }

  try {
    await deleteBranch(r.ctx.tenantId, parsed.data);
  } catch (err) {
    if (err instanceof BranchPrimaryError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof BranchInUseError) {
      return NextResponse.json(
        { error: err.message, counts: err.counts },
        { status: 409 },
      );
    }
    throw err;
  }

  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "branch.delete",
    category: "settings",
    entityType: "branch",
    entityId: before.id,
    entityLabel: before.name,
  });

  return NextResponse.json({ ok: true });
}
