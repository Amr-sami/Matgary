import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireTenant,
  requireTenantWithBranch,
} from "@/lib/api/auth-helpers";
import { resolveBranchFilter } from "@/lib/api/branch-context";
import { addProduct, listProducts } from "@/lib/repo/catalog";
import { logActivity } from "@/lib/repo/activity";

export async function GET(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;

  const filter = await resolveBranchFilter(
    r.ctx,
    req.nextUrl.searchParams.get("branchId"),
  );
  if (!filter.ok) {
    return NextResponse.json({ error: filter.error }, { status: filter.status });
  }

  const data = await listProducts(r.ctx.tenantId, filter.branchId);
  return NextResponse.json({ data, branchId: filter.branchId });
}

const createSchema = z.object({
  name: z.string().min(1).max(200),
  categoryId: z.string().uuid(),
  brand: z.string().max(80).optional(),
  quantity: z.number().int().min(0),
  price: z.number().min(0),
  costPrice: z.number().min(0).optional(),
  lowStockThreshold: z.number().int().min(0).default(3),
  sku: z.string().max(80).optional(),
  tags: z.array(z.string().max(40)).optional(),
  supplier: z.string().max(120).optional(),
  supplierId: z.string().uuid().nullable().optional(),
  location: z.string().max(120).optional(),
  attributeValueIds: z.array(z.string().uuid()).optional(),
});

export async function POST(req: NextRequest) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  // Multi-store: the product is born at the active branch and stays there.
  const { id } = await addProduct(r.ctx.tenantId, r.ctx.branchId, parsed.data);
  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "product.create",
    category: "product",
    entityType: "product",
    entityId: id,
    entityLabel: parsed.data.name,
    branchId: r.ctx.branchId,
    metadata: { quantity: parsed.data.quantity, price: parsed.data.price },
  });
  return NextResponse.json({ id }, { status: 201 });
}
