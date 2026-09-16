import { NextRequest, NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { getCustomerLedger } from "@/lib/repo/customers";
import { normalizeEgyptPhone } from "@/lib/validators/egypt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Customer ledger detail. Phone in URL is URL-encoded (e.g.
 * `%2B201234567890`); Next decodes it for us. We then re-normalise
 * via `normalizeEgyptPhone` so the lookup matches whatever shape was
 * stored on the sale row, and reject obvious junk early.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ phone: string }> },
) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;

  const { phone } = await params;
  const normalised = normalizeEgyptPhone(phone);
  if (!normalised) {
    return NextResponse.json(
      { error: "INVALID_PHONE" },
      { status: 400 },
    );
  }

  const ledger = await getCustomerLedger(
    r.ctx.tenantId,
    r.ctx.branchId,
    normalised,
  );
  if (!ledger) {
    return NextResponse.json(
      { error: "NOT_FOUND" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    data: ledger,
    branchId: r.ctx.branchId,
    branchName: r.ctx.branchName,
  });
}
