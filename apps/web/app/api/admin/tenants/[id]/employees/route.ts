import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import { listTenantEmployees } from "@/lib/admin/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("tenant.read");
  if (!r.ok) return r.response;
  const { id } = await params;
  const data = await listTenantEmployees(id);
  return NextResponse.json({ data });
}
