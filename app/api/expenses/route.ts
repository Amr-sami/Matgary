import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { addExpense, listExpenses } from "@/lib/repo/operations";

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const data = await listExpenses(r.ctx.tenantId);
  return NextResponse.json({ data });
}

const schema = z.object({
  title: z.string().min(1).max(200),
  amount: z.number().min(0),
  category: z.enum(["rent", "salaries", "electricity", "water", "internet", "other"]),
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
    date: parsed.data.date ? new Date(parsed.data.date) : undefined,
  });
  return NextResponse.json(result, { status: 201 });
}
