import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import { listAdminPlans } from "@/lib/admin/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await requirePermission("plan.read");
  if (!r.ok) return r.response;
  const data = await listAdminPlans();
  return NextResponse.json({ data });
}
