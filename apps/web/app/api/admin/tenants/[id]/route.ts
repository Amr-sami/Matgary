import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import { getTenantDetail } from "@/lib/admin/tenants";
import { computeHealthFlags } from "@/lib/admin/health-flags";
import { getTenantSalesPerformance } from "@/lib/admin/sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("tenant.read");
  if (!r.ok) return r.response;
  const { id } = await params;
  const [detail, healthFlags, salesPerformance] = await Promise.all([
    getTenantDetail(id),
    computeHealthFlags(id),
    getTenantSalesPerformance(id),
  ]);
  if (!detail) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ...detail, healthFlags, salesPerformance });
}
