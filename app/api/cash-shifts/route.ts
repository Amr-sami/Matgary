import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requirePermission,
  requireTenantWithBranch,
} from "@/lib/api/auth-helpers";
import { resolveBranchFilter } from "@/lib/api/branch-context";
import { can } from "@/lib/permissions";
import {
  CashShiftConflictError,
  listShifts,
  openShift,
  type CashShiftStatus,
} from "@/lib/repo/cash-shifts";
import { logActivity } from "@/lib/repo/activity";

export async function GET(req: NextRequest) {
  const r = await requirePermission("open_close_shift");
  if (!r.ok) return r.response;
  const isManager = can(r.ctx, "manage_cash_reconciliation");
  const filter = await resolveBranchFilter(
    r.ctx,
    req.nextUrl.searchParams.get("branchId"),
  );
  if (!filter.ok) {
    return NextResponse.json({ error: filter.error }, { status: filter.status });
  }
  const status = req.nextUrl.searchParams.get("status") as
    | CashShiftStatus
    | "needs_review"
    | null;
  const cashierId = req.nextUrl.searchParams.get("cashierId");
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");

  const data = await listShifts(r.ctx.tenantId, {
    // Staff can only see their own shifts; managers see everyone's.
    restrictToCashier: isManager ? undefined : r.ctx.userId,
    cashierUserId: isManager && cashierId ? cashierId : undefined,
    branchId: filter.branchId ?? undefined,
    status: status ?? undefined,
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
  });
  return NextResponse.json({ data, branchId: filter.branchId });
}

const openSchema = z.object({
  openingFloat: z.union([z.number(), z.string()]),
  openingNote: z.string().max(500).nullable().optional(),
});

export async function POST(req: NextRequest) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  if (!can(r.ctx, "open_close_shift")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = openSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }
  try {
    const shift = await openShift(r.ctx.tenantId, {
      branchId: r.ctx.branchId,
      cashierUserId: r.ctx.userId,
      openedByUserId: r.ctx.userId,
      openingFloat: String(parsed.data.openingFloat),
      openingNote: parsed.data.openingNote ?? null,
    });
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "cash_shift.open",
      category: "settings",
      entityType: "cash_shift",
      entityId: shift.id,
      branchId: r.ctx.branchId,
      metadata: { openingFloat: shift.openingFloat },
    });
    return NextResponse.json({ shift }, { status: 201 });
  } catch (err) {
    if (err instanceof CashShiftConflictError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 409 },
      );
    }
    throw err;
  }
}
