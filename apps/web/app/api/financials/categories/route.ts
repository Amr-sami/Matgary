// GET /api/financials/categories — the category tree (system + tenant custom).

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import { listCategoriesTree } from "@/lib/finance/categories";

export async function GET(_req: NextRequest) {
  // Enforced — new permission key, no audit ramp.
  const r = await requirePermission("view_financials");
  if (!r.ok) return r.response;

  const tree = await listCategoriesTree(r.ctx.tenantId);
  return NextResponse.json({ data: tree });
}
