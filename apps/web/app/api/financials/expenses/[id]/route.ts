// PATCH /api/financials/expenses/[id] — edit a subset of fields on a posted
// expense. Voided rows are immutable (the void is the correction).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import { auditFinancial } from "@/lib/finance/audit";
import { updateFinanceExpense } from "@/lib/finance/expense-mutations";
import { uuidShape } from "@/lib/finance/uuid-shape";

const idSchema = uuidShape;

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  amount: z.number().min(0).optional(),
  date: z
    .string()
    .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: "invalid date" })
    .optional(),
  categoryId: uuidShape.optional(),
  paymentMethod: z.enum(["cash", "instapay", "wallet", "card", "other"]).nullable().optional(),
  referenceNumber: z.string().max(80).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  supplierId: uuidShape.nullable().optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requirePermission("manage_expenses");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid_body" },
      { status: 400 },
    );
  }

  // Empty patch is a client bug — return 400 rather than silently succeeding.
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "empty_patch" }, { status: 400 });
  }

  const result = await updateFinanceExpense(auth.ctx.tenantId, id, {
    title: parsed.data.title,
    amount: parsed.data.amount,
    date: parsed.data.date ? new Date(parsed.data.date) : undefined,
    categoryId: parsed.data.categoryId,
    paymentMethod: parsed.data.paymentMethod,
    referenceNumber: parsed.data.referenceNumber,
    note: parsed.data.note,
    supplierId: parsed.data.supplierId,
  });

  if (!result.ok) {
    if (result.reason === "NOT_FOUND")
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    if (result.reason === "VOIDED")
      return NextResponse.json({ error: "VOIDED" }, { status: 409 });
    if (result.reason === "CATEGORY_NOT_FOUND")
      return NextResponse.json({ error: "CATEGORY_NOT_FOUND" }, { status: 400 });
  }

  await auditFinancial({
    tenantId: auth.ctx.tenantId,
    actorUserId: auth.ctx.userId,
    action: "finance.expense.update",
    entityType: "expense",
    entityId: id,
    metadata: {
      kind: "update",
      // Non-sensitive — what the user changed, not the previous value.
      changed: Object.keys(parsed.data),
    },
  });

  return NextResponse.json({ ok: true });
}
