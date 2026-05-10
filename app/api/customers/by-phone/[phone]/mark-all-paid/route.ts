import { NextRequest, NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { can } from "@/lib/permissions";
import { markCustomerAllPaid } from "@/lib/repo/customers";
import { logActivity } from "@/lib/repo/activity";
import { normalizeEgyptPhone } from "@/lib/validators/egypt";

export const runtime = "nodejs";

/**
 * Bulk mark every unpaid sale for one (active branch, customer phone)
 * as paid. Idempotent — second call updates zero rows. Returns the
 * count + total cleared so the UI can show "12 invoices · 4,300 EGP".
 *
 * Permission: same as the single-sale mark-paid (manage_sales) — staff
 * who can clear one invoice can clear all of them.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ phone: string }> },
) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  if (!can(r.ctx, "modify_sales")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { phone } = await params;
  const normalised = normalizeEgyptPhone(phone);
  if (!normalised) {
    return NextResponse.json({ error: "INVALID_PHONE" }, { status: 400 });
  }

  const result = await markCustomerAllPaid(
    r.ctx.tenantId,
    r.ctx.branchId,
    normalised,
  );

  if (result.markedCount > 0) {
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "sale.mark_paid",
      category: "sale",
      branchId: r.ctx.branchId,
      metadata: {
        customerPhone: normalised,
        invoiceCount: result.markedCount,
        markedTotal: result.markedTotal,
        bulk: true,
      },
    });
  }

  return NextResponse.json(result);
}
