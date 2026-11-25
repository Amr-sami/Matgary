// POST /api/financials/expenses/[id]/void — flip the expense to 'voided'.
// Voided rows are excluded from the P&L (see lib/finance/pnl.ts status filter).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import { auditFinancial } from "@/lib/finance/audit";
import { voidFinanceExpense } from "@/lib/finance/expense-mutations";

const idSchema = z.string().uuid();
const bodySchema = z.object({
  reason: z.string().max(500).optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requirePermission("manage_expenses");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const result = await voidFinanceExpense(auth.ctx.tenantId, id, {
    voidedByUserId: auth.ctx.userId,
    reason: parsed.data.reason ?? null,
  });

  if (!result.ok) {
    if (result.reason === "NOT_FOUND")
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    if (result.reason === "ALREADY_VOIDED")
      return NextResponse.json({ error: "ALREADY_VOIDED" }, { status: 409 });
  }

  await auditFinancial({
    tenantId: auth.ctx.tenantId,
    actorUserId: auth.ctx.userId,
    action: "finance.expense.void",
    entityType: "expense",
    entityId: id,
    metadata: { reason: parsed.data.reason ?? null },
  });

  return NextResponse.json({ ok: true });
}
