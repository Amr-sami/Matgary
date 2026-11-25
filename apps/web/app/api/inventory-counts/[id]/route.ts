// GET /api/inventory-counts/[id] — count + lines + summary.

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import { getCount } from "@/lib/repo/inventory-counts";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("view_inventory_counts");
  if (!r.ok) return r.response;
  const { id } = await params;
  const data = await getCount(r.ctx.tenantId, id);
  if (!data) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json(data);
}
