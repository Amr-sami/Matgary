import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  resolveActiveBranch,
  resolveBranchFilter,
} from "@/lib/api/branch-context";
import { addSupplier, listSuppliers } from "@/lib/repo/suppliers";
import { logActivity } from "@/lib/repo/activity";

export async function GET(req: NextRequest) {
  const r = await requirePermission("view_suppliers");
  if (!r.ok) return r.response;
  const filter = await resolveBranchFilter(
    r.ctx,
    req.nextUrl.searchParams.get("branchId"),
  );
  if (!filter.ok) {
    return NextResponse.json({ error: filter.error }, { status: filter.status });
  }
  const data = await listSuppliers(r.ctx.tenantId, filter.branchId);
  return NextResponse.json({ data, branchId: filter.branchId });
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().email().max(120).nullable().optional().or(z.literal("")),
  address: z.string().max(255).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export async function POST(req: NextRequest) {
  const r = await requirePermission("manage_suppliers");
  if (!r.ok) return r.response;
  const branch = await resolveActiveBranch(r.ctx);
  if (!branch) {
    return NextResponse.json(
      { error: "NO_BRANCH_ACCESS" },
      { status: 403 },
    );
  }
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const result = await addSupplier(r.ctx.tenantId, branch.branchId, {
    name: parsed.data.name,
    phone: parsed.data.phone || null,
    email: parsed.data.email || null,
    address: parsed.data.address || null,
    notes: parsed.data.notes || null,
  });
  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "supplier.create",
    category: "supplier",
    entityType: "supplier",
    entityId: (result as { id?: string }).id ?? null,
    entityLabel: parsed.data.name,
    branchId: branch.branchId,
  });
  return NextResponse.json(result, { status: 201 });
}
