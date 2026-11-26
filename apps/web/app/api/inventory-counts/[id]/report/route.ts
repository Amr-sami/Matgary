// GET /api/inventory-counts/[id]/report
// Authoritative report payload. Uses `inventory_count_reconciliations` as the
// source of truth for completed counts — never recomputes `counted - baseline`
// because that ignores concurrent movement the confirm did factor in.

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import { getCountReport } from "@/lib/repo/inventory-counts";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("view_inventory_counts");
  if (!r.ok) return r.response;
  const { id } = await params;
  const report = await getCountReport(r.ctx.tenantId, id);
  if (!report) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json(report);
}
