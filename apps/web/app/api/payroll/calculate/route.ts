// POST /api/payroll/calculate — recompute and upsert the DRAFT payroll for
// one employee + month. Idempotent. The AI's `preview_calculate_payroll`
// tool and the web "Calculate" button both land here.
//
// Body: { employeeId, month: "YYYY-MM" }
// Response: { sheet: PayrollSheetView }

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import { logActivity } from "@/lib/repo/activity";
import {
  PayrollLifecycleError,
  upsertPayrollDraft,
} from "@/lib/repo/payroll-periods";
import { uuidShape } from "@/lib/finance/uuid-shape";
import { parseMonthParam } from "../_shared";

const schema = z.object({
  employeeId: uuidShape,
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

export async function POST(req: NextRequest) {
  const r = await requirePermission("manage_payroll");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const periodStart = parseMonthParam(parsed.data.month);
  if (!periodStart) {
    return NextResponse.json({ error: "invalid_month" }, { status: 400 });
  }
  try {
    const sheet = await upsertPayrollDraft(
      r.ctx.tenantId,
      parsed.data.employeeId,
      periodStart,
    );
    await logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "payroll.calculate",
      category: "payroll",
      entityType: "payroll_period",
      entityId: sheet.periodId ?? parsed.data.employeeId,
      metadata: {
        employeeId: parsed.data.employeeId,
        month: parsed.data.month,
        grossAmount: sheet.snapshot.grossAmount,
        netAmount: sheet.snapshot.netAmount,
      },
    });
    return NextResponse.json({ sheet });
  } catch (e) {
    if (e instanceof PayrollLifecycleError) {
      return NextResponse.json({ error: e.code }, { status: 409 });
    }
    throw e;
  }
}
