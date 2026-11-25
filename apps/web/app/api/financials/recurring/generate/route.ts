// POST /api/financials/recurring/generate — kick the recurring-expense
// generator for the caller's tenant. Idempotent: the existing helper
// advances `next_occurrence_date` on every spawn, so a repeated call in the
// same minute produces 0 extra rows. The partial UNIQUE index on
// (tenant_id, parent_expense_id, date) in migration 0064 is the defence-in-
// depth guard at the DB layer.
//
// Returns `{ spawned }` — how many child expense rows were created on this
// call. 0 means nothing was due.

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import { auditFinancial } from "@/lib/finance/audit";
import { materializeDueRecurringExpenses } from "@/lib/repo/expenses";

export const runtime = "nodejs";

export async function POST() {
  const auth = await requirePermission("manage_recurring_expenses");
  if (!auth.ok) return auth.response;

  const { spawned } = await materializeDueRecurringExpenses(auth.ctx.tenantId);

  // Only audit when work happened; empty runs would spam the activity feed.
  if (spawned > 0) {
    await auditFinancial({
      tenantId: auth.ctx.tenantId,
      actorUserId: auth.ctx.userId,
      action: "finance.recurring.create",
      entityType: "recurring_generator",
      entityId: null,
      metadata: { spawned },
    });
  }

  return NextResponse.json({ spawned });
}
