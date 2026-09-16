import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import {
  settleCustomerPayment,
  SettlementError,
} from "@/lib/repo/operations";
import { normalizeEgyptPhone } from "@/lib/validators/egypt";
import { logActivity } from "@/lib/repo/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sales/settle — record a customer settlement against their
// outstanding balance. Applies oldest-first by default; the caller can
// hand-pick invoices via `invoiceIds`. Cash settlements stamp the active
// cash shift so Z-report sees the receipt. See settleCustomerPayment in
// lib/repo/operations.ts for the apply-allocation contract.

const schema = z.object({
  customerPhone: z.string().min(1).max(40),
  amount: z.number().positive().max(10_000_000),
  method: z.enum(["cash", "instapay", "card"]),
  invoiceIds: z.array(z.string().max(80)).max(50).optional(),
});

export async function POST(req: NextRequest) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "INVALID" },
      { status: 400 },
    );
  }

  // Normalise the phone the same way recordCartSale does so the lookup
  // matches across "0100…" / "+20100…" / "00 20…" entries.
  const phone = normalizeEgyptPhone(parsed.data.customerPhone);
  if (!phone) {
    return NextResponse.json({ error: "INVALID_PHONE" }, { status: 400 });
  }

  try {
    const result = await settleCustomerPayment(r.ctx.tenantId, {
      customerPhone: phone,
      amount: parsed.data.amount,
      method: parsed.data.method,
      invoiceIds: parsed.data.invoiceIds,
      recordedByUserId: r.ctx.userId,
      branchId: r.ctx.branchId,
    });

    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "sale.customer_settlement",
      category: "sale",
      entityType: "customer",
      entityId: phone,
      metadata: {
        amountApplied: result.appliedAmount,
        method: parsed.data.method,
        fullySettledInvoices: result.fullySettledInvoices,
        newBalance: result.newBalance,
        overpay: result.overpay,
      },
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SettlementError) {
      return NextResponse.json({ error: err.code }, { status: err.httpStatus });
    }
    // Log + surface the underlying message so the UI can show something
    // useful (rather than a generic "تعذر تسجيل الدفعة" fallback). 500
    // responses with no error body are the hardest class of bugs to
    // chase down in production.
    console.error("[/api/sales/settle] unexpected error:", err);
    return NextResponse.json(
      {
        error: "INTERNAL",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
