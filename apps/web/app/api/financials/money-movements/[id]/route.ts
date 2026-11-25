// PATCH /api/financials/money-movements/[id] — edit metadata only (description,
//   payment method, related entity). Amount/kind/date are intentionally fixed:
//   wrong values are corrected by voiding + re-recording.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import { auditFinancial } from "@/lib/finance/audit";
import { updateMoneyMovement } from "@/lib/finance/money-movement-mutations";

const idSchema = z.string().uuid();
const patchSchema = z.object({
  description: z.string().max(500).nullable().optional(),
  paymentMethod: z.enum(["cash", "instapay", "wallet", "card", "other"]).nullable().optional(),
  relatedEntityType: z.string().max(40).nullable().optional(),
  relatedEntityId: z.string().uuid().nullable().optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requirePermission("manage_money_movements");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!idSchema.safeParse(id).success)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid_body" },
      { status: 400 },
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "empty_patch" }, { status: 400 });
  }

  const r = await updateMoneyMovement(auth.ctx.tenantId, id, parsed.data);
  if (!r.ok) {
    if (r.reason === "NOT_FOUND")
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ error: "VOIDED" }, { status: 409 });
  }

  await auditFinancial({
    tenantId: auth.ctx.tenantId,
    actorUserId: auth.ctx.userId,
    action: "finance.money_movement.update",
    entityType: "money_movement",
    entityId: id,
    metadata: { changed: Object.keys(parsed.data) },
  });

  return NextResponse.json({ ok: true });
}
