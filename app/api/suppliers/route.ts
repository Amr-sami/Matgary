import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import { addSupplier, listSuppliers } from "@/lib/repo/suppliers";

export async function GET() {
  const r = await requirePermission("view_suppliers");
  if (!r.ok) return r.response;
  const data = await listSuppliers(r.ctx.tenantId);
  return NextResponse.json({ data });
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
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const result = await addSupplier(r.ctx.tenantId, {
    name: parsed.data.name,
    phone: parsed.data.phone || null,
    email: parsed.data.email || null,
    address: parsed.data.address || null,
    notes: parsed.data.notes || null,
  });
  return NextResponse.json(result, { status: 201 });
}
