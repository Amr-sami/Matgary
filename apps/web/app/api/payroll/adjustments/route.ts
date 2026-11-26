// GET  /api/payroll/adjustments?employeeId&month=YYYY-MM — list live
//        (non-voided) adjustments for one employee + month.
// POST /api/payroll/adjustments — create a signed adjustment entry.
//
// Signs on `amount` follow the DB CHECK:
//   kind='bonus'            → amount > 0
//   kind='deduction'        → amount < 0
//   kind='advance_repayment'→ amount < 0
//   kind='correction'       → either sign allowed

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import { logActivity } from "@/lib/repo/activity";
import {
  PayrollLifecycleError,
  createPayrollAdjustment,
  listPayrollAdjustments,
} from "@/lib/repo/payroll-periods";
import { uuidShape } from "@/lib/finance/uuid-shape";
import { parseMonthParam } from "../_shared";

const ADJUSTMENT_KINDS = ["bonus", "deduction", "advance_repayment", "correction"] as const;

const listSchema = z.object({
  employeeId: uuidShape,
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

export async function GET(req: NextRequest) {
  const r = await requirePermission("manage_payroll");
  if (!r.ok) return r.response;
  const parsed = listSchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }
  const periodStart = parseMonthParam(parsed.data.month);
  if (!periodStart) {
    return NextResponse.json({ error: "invalid_month" }, { status: 400 });
  }
  const rows = await listPayrollAdjustments(
    r.ctx.tenantId,
    parsed.data.employeeId,
    periodStart,
  );
  return NextResponse.json({
    rows: rows.map((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      periodMonth: row.periodMonth.toISOString(),
      kind: row.kind,
      amount: Number(row.amount),
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
      createdByUserId: row.createdByUserId,
    })),
  });
}

const createSchema = z.object({
  employeeId: uuidShape,
  month: z.string().regex(/^\d{4}-\d{2}$/),
  kind: z.enum(ADJUSTMENT_KINDS),
  amount: z.number().refine(Number.isFinite, "amount must be finite"),
  reason: z.string().max(500).optional().nullable(),
});

export async function POST(req: NextRequest) {
  const r = await requirePermission("manage_payroll");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid_body" },
      { status: 400 },
    );
  }
  const { employeeId, month, kind, amount, reason } = parsed.data;

  // Client-side sign hygiene before hitting the DB CHECK. Keeps the 409
  // response under our control instead of a Postgres-shaped 500.
  if (kind === "bonus" && amount <= 0) {
    return NextResponse.json({ error: "bonus must be positive" }, { status: 400 });
  }
  if ((kind === "deduction" || kind === "advance_repayment") && amount >= 0) {
    return NextResponse.json({ error: `${kind} must be negative` }, { status: 400 });
  }

  const periodStart = parseMonthParam(month);
  if (!periodStart) {
    return NextResponse.json({ error: "invalid_month" }, { status: 400 });
  }
  try {
    const row = await createPayrollAdjustment(r.ctx.tenantId, {
      employeeId,
      periodStart,
      kind,
      amount,
      reason: reason ?? null,
      createdByUserId: r.ctx.userId,
    });
    await logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "payroll.adjustment_create",
      category: "payroll",
      entityType: "payroll_adjustment",
      entityId: row.id,
      metadata: {
        employeeId,
        month,
        kind,
        amount,
        reason: reason ?? null,
      },
    });
    return NextResponse.json(
      {
        row: {
          id: row.id,
          employeeId: row.employeeId,
          periodMonth: row.periodMonth.toISOString(),
          kind: row.kind,
          amount: Number(row.amount),
          reason: row.reason,
          createdAt: row.createdAt.toISOString(),
          createdByUserId: row.createdByUserId,
        },
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof PayrollLifecycleError) {
      return NextResponse.json({ error: e.code }, { status: 409 });
    }
    throw e;
  }
}
