import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  createPurchaseOrder,
  listPurchaseOrders,
  PurchaseOrderConflictError,
  type PurchaseOrderStatus,
} from "@/lib/repo/purchase-orders";

const STATUS_VALUES = ["draft", "received", "cancelled"] as const;

export async function GET(req: NextRequest) {
  const r = await requirePermission("view_purchases");
  if (!r.ok) return r.response;
  const supplierId = req.nextUrl.searchParams.get("supplierId") || undefined;
  const statusParam = req.nextUrl.searchParams.get("status") as
    | PurchaseOrderStatus
    | null;
  const status = statusParam && (STATUS_VALUES as readonly string[]).includes(statusParam)
    ? (statusParam as PurchaseOrderStatus)
    : undefined;
  const data = await listPurchaseOrders(r.ctx.tenantId, { supplierId, status });
  return NextResponse.json({ data });
}

const createSchema = z.object({
  supplierId: z.string().uuid(),
  notes: z.string().max(2000).nullable().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid().nullable().optional(),
        productName: z.string().min(1).max(200),
        quantity: z.number().int().min(1),
        unitCost: z.number().min(0),
      }),
    )
    .min(1),
});

export async function POST(req: NextRequest) {
  const r = await requirePermission("manage_purchases");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  try {
    const result = await createPurchaseOrder(r.ctx.tenantId, {
      supplierId: parsed.data.supplierId,
      notes: parsed.data.notes ?? null,
      items: parsed.data.items.map((i) => ({
        productId: i.productId ?? null,
        productName: i.productName,
        quantity: i.quantity,
        unitCost: i.unitCost,
      })),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof PurchaseOrderConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
