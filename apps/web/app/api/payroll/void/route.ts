// POST /api/payroll/void — FINALIZED → VOIDED by period id. One-way.
// Must carry a reason so audit-trail readers know why the sheet was retracted.
//
// Body: { periodId: uuid, reason?: string }

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import { logActivity } from "@/lib/repo/activity";
import {
  PayrollLifecycleError,
  voidPayrollPeriod,
} from "@/lib/repo/payroll-periods";
import { uuidShape } from "@/lib/finance/uuid-shape";

const schema = z.object({
  periodId: uuidShape,
  reason: z.string().max(500).optional().nullable(),
});

export async function POST(req: NextRequest) {
  const r = await requirePermission("manage_payroll");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  try {
    const row = await voidPayrollPeriod(
      r.ctx.tenantId,
      parsed.data.periodId,
      r.ctx.userId,
      parsed.data.reason ?? null,
    );
    await logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "payroll.void",
      category: "payroll",
      entityType: "payroll_period",
      entityId: row.id,
      metadata: {
        employeeId: row.employeeId,
        periodStart: row.periodStart.toISOString(),
        reason: parsed.data.reason ?? null,
      },
    });
    return NextResponse.json({ ok: true, id: row.id });
  } catch (e) {
    if (e instanceof PayrollLifecycleError) {
      return NextResponse.json({ error: e.code }, { status: 409 });
    }
    throw e;
  }
}
