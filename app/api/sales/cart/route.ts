import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { recordCartSale } from "@/lib/repo/operations";
import { logActivity } from "@/lib/repo/activity";
import { normalizeEgyptPhone } from "@/lib/validators/egypt";

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
  // Customer phone normalises to canonical +20 form so the customer-history
  // lookup matches across "0100…" and "+20100…" entries. Junk input becomes
  // null rather than rejecting the sale (the cashier shouldn't be blocked
  // from ringing up because of a typo).
  const normalisedCustomerPhone = parsed.data.options?.customerPhone
    ? normalizeEgyptPhone(parsed.data.options.customerPhone) ?? null
    : null;
  try {
    const result = await recordCartSale(r.ctx.tenantId, parsed.data.lines, {
      ...parsed.data.options,
      customerPhone: normalisedCustomerPhone ?? undefined,
      customDate: parsed.data.options?.customDate
        ? new Date(parsed.data.options.customDate)
        : undefined,
      recordedByUserId: r.ctx.userId,
    });
    const totalQty = result.lines.reduce((s, l) => s + l.quantity, 0);
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "sale.create",
      category: "sale",
      entityType: "sale",
      entityId: result.saleIds[0] ?? null,
      entityLabel: result.invoiceId,
      metadata: {
        invoiceId: result.invoiceId,
        lineCount: result.lines.length,
        totalQuantity: totalQty,
        total: result.total,
        paymentMethod: result.paymentMethod,
        customerName: result.customerName,
        customerPhone: result.customerPhone,
        note: result.note,
        lines: result.lines,
      },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "خطأ" },
      { status: 400 },
    );
  }
}
