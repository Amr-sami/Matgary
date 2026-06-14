import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  requireTenant,
  requireTenantWithBranch,
} from "@/lib/api/auth-helpers";
import { resolveBranchFilter } from "@/lib/api/branch-context";
import { resolveSinceWindow } from "@/lib/api/list-window";
import { addExpense, listExpenses } from "@/lib/repo/operations";
import { logActivity } from "@/lib/repo/activity";
import { withTenant } from "@/lib/db";
import { branches } from "@/lib/db/schema";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";

export async function GET(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const filter = await resolveBranchFilter(
    r.ctx,
    req.nextUrl.searchParams.get("branchId"),
  );
  if (!filter.ok) {
    return NextResponse.json({ error: filter.error }, { status: filter.status });
  }
  // Default: last 90 days. Expense reporting typically goes 1-3 months
  // back; longer history is admin/export work (`?all=1`).
  const since = resolveSinceWindow(req, { defaultDays: 90 });
  const data = await listExpenses(r.ctx.tenantId, filter.branchId, since);
  return NextResponse.json({ data, branchId: filter.branchId });
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
  /** Branch this expense is incurred at. Owners may explicitly send `null`
   *  to mark a tenant-wide expense (rare). When the field is omitted we
   *  default to the active branch. */
  branchId: z.string().uuid().nullable().optional(),
});

export async function POST(req: NextRequest) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  // Resolve branchId: explicit > active. Validate ownership when explicit so
  // a malicious payload can't book an expense to another tenant's branch.
  let resolvedBranchId: string | null;
  if (parsed.data.branchId === null) {
    if (r.ctx.role !== "owner") {
      return NextResponse.json(
        { error: "TENANT_WIDE_EXPENSE_OWNER_ONLY" },
        { status: 403 },
      );
    }
    resolvedBranchId = null;
  } else if (parsed.data.branchId) {
    const [b] = await withTenant(r.ctx.tenantId, (tx) =>
      tx
        .select({ id: branches.id })
        .from(branches)
        .where(
          and(
            eq(branches.tenantId, r.ctx.tenantId),
            eq(branches.id, parsed.data.branchId!),
          ),
        )
        .limit(1),
    );
    if (!b) {
      return NextResponse.json({ error: "INVALID_BRANCH" }, { status: 400 });
    }
    resolvedBranchId = parsed.data.branchId;
  } else {
    resolvedBranchId = r.ctx.branchId;
  }

  const result = await addExpense(r.ctx.tenantId, {
    ...parsed.data,
    supplierId: parsed.data.supplierId ?? null,
    isRecurring: parsed.data.isRecurring ?? false,
    recurrencePeriod: parsed.data.recurrencePeriod ?? null,
    date: parsed.data.date ? new Date(parsed.data.date) : undefined,
    branchId: resolvedBranchId,
    recordedByUserId: r.ctx.userId,
    recordedByRole: r.ctx.role === "owner" ? "owner" : "staff",
  });
  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "expense.create",
    category: "expense",
    entityType: "expense",
    entityId: (result as { id?: string }).id ?? null,
    entityLabel: parsed.data.title,
    branchId: resolvedBranchId,
    metadata: { amount: parsed.data.amount, category: parsed.data.category },
  });
  return NextResponse.json(result, { status: 201 });
}
