// GET /api/financials/expenses — list with server-side filters + keyset pagination.
// POST /api/financials/expenses — create a new posted expense.
//
// Both routes enforce `view_financials` + the appropriate write permission
// server-side (not frontend-only). Every write lands in the audit log.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import {
  CategoryNotFoundError,
  PayrollDoubleCountError,
  createFinanceExpense,
  listFinanceExpenses,
} from "@/lib/finance/expense-mutations";
import { auditFinancial } from "@/lib/finance/audit";
import { uuidShape } from "@/lib/finance/uuid-shape";

const listQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  // uuidShape, not z.string().uuid(): the seeded system category IDs
  // (migration 0064) have variant nibble `0` and fail RFC 4122.
  categoryId: uuidShape.optional(),
  paymentMethod: z.string().max(40).optional(),
  status: z.enum(["posted", "voided", "any"]).optional(),
  minAmount: z.coerce.number().min(0).optional(),
  maxAmount: z.coerce.number().min(0).optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(100).nullable().optional(),
});

export async function GET(req: NextRequest) {
  const r = await requirePermission("view_financials");
  if (!r.ok) return r.response;

  const parsed = listQuerySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  const q = parsed.data;
  const page = await listFinanceExpenses(r.ctx.tenantId, {
    from: q.from ? new Date(q.from) : undefined,
    to: q.to ? new Date(q.to) : undefined,
    categoryId: q.categoryId,
    paymentMethod: q.paymentMethod,
    status: q.status,
    minAmount: q.minAmount,
    maxAmount: q.maxAmount,
    search: q.search,
    limit: q.limit,
    cursor: q.cursor ?? null,
  });
  return NextResponse.json(page);
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  amount: z.number().min(0),
  // ISO date-time OR plain date — accept both for convenience.
  date: z
    .string()
    .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: "invalid date" }),
  // uuidShape accepts seeded system categories too (00000000-0000-4011-…).
  categoryId: uuidShape,
  paymentMethod: z.enum(["cash", "instapay", "wallet", "card", "other"]).optional().nullable(),
  referenceNumber: z.string().max(80).optional().nullable(),
  note: z.string().max(500).optional().nullable(),
  supplierId: uuidShape.optional().nullable(),
});

export async function POST(req: NextRequest) {
  // `manage_expenses` is the existing permission for expense writes (used by
  // the legacy /api/expenses). The Financials UI is also gated by
  // `view_financials` so we check both — view_financials to open the page,
  // manage_expenses to mutate.
  const auth = await requirePermission("manage_expenses");
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid_body" },
      { status: 400 },
    );
  }

  try {
    const result = await createFinanceExpense(auth.ctx.tenantId, {
      title: parsed.data.title,
      amount: parsed.data.amount,
      date: new Date(parsed.data.date),
      categoryId: parsed.data.categoryId,
      paymentMethod: parsed.data.paymentMethod ?? null,
      referenceNumber: parsed.data.referenceNumber ?? null,
      note: parsed.data.note ?? null,
      supplierId: parsed.data.supplierId ?? null,
      createdByUserId: auth.ctx.userId,
    });

    // Audit AFTER the write succeeds; if the activity log flakes, the
    // expense still exists and the P&L is correct.
    await auditFinancial({
      tenantId: auth.ctx.tenantId,
      actorUserId: auth.ctx.userId,
      action: "finance.expense.create",
      entityType: "expense",
      entityId: result.id,
      entityLabel: parsed.data.title,
      metadata: {
        amount: parsed.data.amount,
        categoryId: parsed.data.categoryId,
        paymentMethod: parsed.data.paymentMethod ?? null,
      },
    });

    return NextResponse.json({ id: result.id }, { status: 201 });
  } catch (err) {
    if (err instanceof CategoryNotFoundError) {
      return NextResponse.json({ error: "CATEGORY_NOT_FOUND" }, { status: 400 });
    }
    if (err instanceof PayrollDoubleCountError) {
      return NextResponse.json(
        {
          error: "PAYROLL_DOUBLE_COUNT",
          periodStart: err.periodStart.toISOString(),
          categorySlug: err.categorySlug,
        },
        { status: 409 },
      );
    }
    throw err;
  }
}
