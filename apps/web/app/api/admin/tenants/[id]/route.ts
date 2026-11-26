import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import { getTenantDetail } from "@/lib/admin/tenants";
import { computeHealthFlags } from "@/lib/admin/health-flags";
import { getTenantSalesPerformance } from "@/lib/admin/sales";
import { computeStoreHealthDetail } from "@/lib/admin/store-health";
import { getTenantPresence } from "@/lib/admin/presence-analytics";
import {
  getTenantCounts,
  getTenantTopCategories,
} from "@/lib/admin/tenant-counts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("tenant.read");
  if (!r.ok) return r.response;
  const { id } = await params;
  const [
    detail,
    healthFlags,
    salesPerformance,
    healthRisk,
    presence,
    counts,
    topCategories,
  ] = await Promise.all([
    getTenantDetail(id),
    computeHealthFlags(id),
    getTenantSalesPerformance(id),
    computeStoreHealthDetail(id),
    getTenantPresence(id),
    getTenantCounts(id),
    getTenantTopCategories(id),
  ]);
  if (!detail) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    ...detail,
    healthFlags,
    salesPerformance,
    storeHealth: healthRisk
      ? { health: healthRisk.health, risk: healthRisk.risk }
      : null,
    presence,
    counts: {
      ...detail.counts,
      ...counts,
      topCategories,
    },
  });
}
