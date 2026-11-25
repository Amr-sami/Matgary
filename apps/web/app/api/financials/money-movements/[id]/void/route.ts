// POST /api/financials/money-movements/[id]/void — soft-void the movement.
// The row stays for audit; the P&L engine already ignores voided movements
// (see fetchPnLSource filter `voided_at IS NULL`).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import { auditFinancial } from "@/lib/finance/audit";
import { voidMoneyMovement } from "@/lib/finance/money-movement-mutations";

const idSchema = z.string().uuid();
const bodySchema = z.object({ reason: z.string().max(500).optional() });

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requirePermission("manage_money_movements");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!idSchema.safeParse(id).success)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const r = await voidMoneyMovement(auth.ctx.tenantId, id, {
    voidedByUserId: auth.ctx.userId,
    reason: parsed.data.reason ?? null,
  });
  if (!r.ok) {
    if (r.reason === "NOT_FOUND")
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ error: "ALREADY_VOIDED" }, { status: 409 });
  }

  await auditFinancial({
    tenantId: auth.ctx.tenantId,
    actorUserId: auth.ctx.userId,
    action: "finance.money_movement.void",
    entityType: "money_movement",
    entityId: id,
    metadata: { reason: parsed.data.reason ?? null },
  });

  return NextResponse.json({ ok: true });
}
