import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import { listTenantActivity } from "@/lib/admin/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("tenant.read");
  if (!r.ok) return r.response;
  const { id } = await params;
  const limit = req.nextUrl.searchParams.get("limit");
  const data = await listTenantActivity(id, limit ? Math.min(500, Math.max(1, Number(limit))) : 50);
  return NextResponse.json({ data });
}
