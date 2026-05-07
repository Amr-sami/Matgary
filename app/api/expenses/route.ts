import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { addExpense, listExpenses } from "@/lib/repo/operations";
import { logActivity } from "@/lib/repo/activity";

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const data = await listExpenses(r.ctx.tenantId);
  return NextResponse.json({ data });
}

const schema = z.object({
  title: z.string().min(1).max(200),
  amount: z.number().min(0),
  category: z.enum(["rent", "salaries", "electricity", "water", "internet", "supplier", "other"]),
  supplierId: z.string().uuid().nullable().optional(),
  isRecurring: z.boolean().optional(),
  recurrencePeriod: z.enum(["monthly", "weekly"]).nullable().optional(),
  date: z.string().datetime().optional(),
  note: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const result = await addExpense(r.ctx.tenantId, {
    ...parsed.data,
    supplierId: parsed.data.supplierId ?? null,
    isRecurring: parsed.data.isRecurring ?? false,
    recurrencePeriod: parsed.data.recurrencePeriod ?? null,
    date: parsed.data.date ? new Date(parsed.data.date) : undefined,
  });
  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "expense.create",
    category: "expense",
    entityType: "expense",
    entityId: (result as { id?: string }).id ?? null,
    entityLabel: parsed.data.title,
    metadata: { amount: parsed.data.amount, category: parsed.data.category },
  });
  return NextResponse.json(result, { status: 201 });
}
