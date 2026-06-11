import { NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { getCurrentShift } from "@/lib/repo/cash-shifts";

// "What is my open shift right now?" — used by the topbar drawer chip,
// the POS to know whether to prompt for opening one, and the close-shift
// flow. Returns null when none is open.
export async function GET() {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const shift = await getCurrentShift(
    r.ctx.tenantId,
    r.ctx.branchId,
    r.ctx.userId,
  );
  return NextResponse.json({ shift });
}
