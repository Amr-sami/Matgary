import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { withTenant } from "@/lib/db";
import { normalizeEgyptPhone } from "@/lib/validators/egypt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/customers/by-phone/{phone}/payments
 *
 * Returns every payment event recorded against this customer's sales in
 * the active branch, newest-first. Joined with `sales` so the response
 * carries `invoiceId` per event — the customer detail page groups by
 * that key to render a per-invoice timeline directly under each
 * invoice card.
 *
 * Optional `?invoiceId=INV-...` narrows to one invoice's history (used
 * by the per-invoice settle modal to show "previous payments" inline).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ phone: string }> },
) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;

  const { phone } = await params;
  const normalised = normalizeEgyptPhone(phone);
  if (!normalised) {
    return NextResponse.json({ error: "INVALID_PHONE" }, { status: 400 });
  }

  const invoiceFilter = req.nextUrl.searchParams.get("invoiceId");

  // Branch-scoped so a multi-branch tenant only sees this branch's slice
  // of the customer's history — matches how /api/customers/by-phone reads.
  const rows = (await withTenant(r.ctx.tenantId, async (tx) =>
    tx.execute(sql`
      SELECT
        p.id,
        p.sale_id        AS "saleId",
        s.invoice_id     AS "invoiceId",
        p.amount,
        p.method,
        p.recorded_at    AS "recordedAt",
        p.note,
        u.name           AS "recordedByName"
      FROM sale_payments p
      JOIN sales s ON s.id = p.sale_id
      LEFT JOIN users u ON u.id = p.recorded_by_user_id
      WHERE p.tenant_id      = ${r.ctx.tenantId}
        AND s.tenant_id      = ${r.ctx.tenantId}
        AND s.branch_id      = ${r.ctx.branchId}
        AND s.customer_phone = ${normalised}
        ${invoiceFilter ? sql`AND s.invoice_id = ${invoiceFilter}` : sql``}
      ORDER BY p.recorded_at DESC, p.id DESC
    `),
  )) as unknown as Array<{
    id: string;
    saleId: string;
    invoiceId: string | null;
    amount: string;
    method: string;
    recordedAt: Date;
    note: string | null;
    recordedByName: string | null;
  }>;

  return NextResponse.json({
    data: rows.map((row) => ({
      id: row.id,
      saleId: row.saleId,
      invoiceId: row.invoiceId,
      amount: Number(row.amount),
      method: row.method,
      recordedAt: row.recordedAt,
      note: row.note,
      recordedByName: row.recordedByName,
    })),
  });
}
