import { NextRequest, NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { getWallet } from "@/lib/repo/loyalty";
import { normalizeEgyptPhone } from "@/lib/validators/egypt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read a customer's wallet (points + credit + recent events) for the
 *  active branch. Returns zero balances when no wallet row exists yet. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ phone: string }> },
) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const { phone } = await params;
  const normalised = normalizeEgyptPhone(phone);
  if (!normalised) {
    return NextResponse.json({ error: "INVALID_PHONE" }, { status: 400 });
  }
  const data = await getWallet(r.ctx.tenantId, r.ctx.branchId, normalised);
  return NextResponse.json({
    ...data,
    branchId: r.ctx.branchId,
    branchName: r.ctx.branchName,
  });
}
