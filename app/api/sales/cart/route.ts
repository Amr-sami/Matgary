import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { recordCartSale } from "@/lib/repo/operations";

const lineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1),
  pricePerUnit: z.number().min(0),
  lineDiscountType: z.enum(["percentage", "fixed"]).optional(),
  lineDiscountValue: z.number().min(0).optional(),
});

const schema = z.object({
  lines: z.array(lineSchema).min(1),
  options: z
    .object({
      note: z.string().max(500).optional(),
      orderDiscountType: z.enum(["percentage", "fixed"]).optional(),
      orderDiscountValue: z.number().min(0).optional(),
      customDate: z.string().datetime().optional(),
      customerName: z.string().max(120).optional(),
      customerPhone: z.string().max(40).optional(),
      paymentMethod: z.enum(["cash", "instapay", "card", "deferred"]).optional(),
    })
    .optional(),
});

export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  try {
    const result = await recordCartSale(r.ctx.tenantId, parsed.data.lines, {
      ...parsed.data.options,
      customDate: parsed.data.options?.customDate
        ? new Date(parsed.data.options.customDate)
        : undefined,
      recordedByUserId: r.ctx.userId,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "خطأ" },
      { status: 400 },
    );
  }
}
