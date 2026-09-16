import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import { getOverview } from "@/lib/admin/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await requirePermission("tenant.read");
  if (!r.ok) return r.response;
  const payload = await getOverview();
  return NextResponse.json(payload);
}
