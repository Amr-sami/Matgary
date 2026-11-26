import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import { PurchaseOrderConflictError } from "@/lib/repo/purchase-orders";
import {
  listPayments,
  recordPayment,
} from "@/lib/repo/purchase-payments";

const METHODS = ["cash", "bank", "vfcash", "instapay", "other"] as const;

const createSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(METHODS).optional(),
  paidAt: z.string().datetime().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("view_purchases");
  if (!r.ok) return r.response;
  const { id } = await params;
  const data = await listPayments(r.ctx.tenantId, id);
  return NextResponse.json({ data });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("manage_purchases");
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  try {
    const result = await recordPayment(r.ctx.tenantId, id, {
      amount: parsed.data.amount,
      method: parsed.data.method,
      paidAt: parsed.data.paidAt ? new Date(parsed.data.paidAt) : null,
      notes: parsed.data.notes ?? null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof PurchaseOrderConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
