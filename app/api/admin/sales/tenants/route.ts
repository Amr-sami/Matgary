import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import { listTenantSales, type SalesRange } from "@/lib/admin/sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANGE_VALUES: SalesRange[] = [
  "this_month",
  "last_month",
  "this_year",
  "last_30d",
  "last_90d",
];

export async function GET(req: NextRequest) {
  const r = await requirePermission("tenant.read");
  if (!r.ok) return r.response;
  const sp = req.nextUrl.searchParams;
  const range = (sp.get("range") ?? "this_month") as SalesRange;
  const safeRange = RANGE_VALUES.includes(range) ? range : "this_month";
  const status = sp.get("status");
  const data = await listTenantSales({
    range: safeRange,
    plan: sp.get("plan") || undefined,
    status:
      status === "active" ||
      status === "trialing" ||
      status === "paying" ||
      status === "suspended"
        ? status
        : undefined,
    limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
  });
  return NextResponse.json({ data });
}
