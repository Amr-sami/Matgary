import { NextRequest, NextResponse } from "next/server";
import { requirePermissionWithBranchEnforced } from "@/lib/api/auth-helpers";
import { resolveBranchFilter } from "@/lib/api/branch-context";
import { requireCollectionsTenant } from "@/lib/collections/flags";
import { errorResponse, handleRouteError } from "@/lib/collections/route-helpers";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import { getCollectionsSummary } from "@/lib/repo/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/collections/summary?date=YYYY-MM-DD&branchId= — the digital "Z":
// per receiving account, one business day in the tenant's time zone
// (05 §4.13, Q12). Buckets by rung_at; `totals.cashRemainder` is the cash
// taken at the counter on split invoices. `date` omitted = today (tenant tz).

/** YYYY-MM-DD that exists on the calendar (2026-02-30 is refused, not a 500). */
function isCalendarDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

export async function GET(req: NextRequest) {
  const r = await requirePermissionWithBranchEnforced("view_collections");
  if (!r.ok) return r.response;
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "reports.read");
  if (!rl.ok) return rl.response;

  const q = req.nextUrl.searchParams;
  const filter = await resolveBranchFilter(r.ctx, q.get("branchId"));
  if (!filter.ok) return errorResponse(filter.error, filter.status);
  const date = q.get("date");
  if (date && !isCalendarDate(date)) {
    return errorResponse("INVALID_REQUEST", 400, { path: "date", message: "must be YYYY-MM-DD" });
  }

  try {
    const summary = await getCollectionsSummary(r.ctx.tenantId, { date, branchId: filter.branchId });
    return NextResponse.json(summary);
  } catch (err) {
    return handleRouteError(err, "GET /api/collections/summary");
  }
}
