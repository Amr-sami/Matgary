import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { grantCredit } from "@/lib/repo/loyalty";
import { logActivity } from "@/lib/repo/activity";
import { normalizeEgyptPhone } from "@/lib/validators/egypt";

export const runtime = "nodejs";

const schema = z.object({
  /** Signed amount in EGP. Positive = grant, negative = deduct. */
  amountEgp: z
    .number()
    .refine((v) => Number.isFinite(v) && v !== 0, "amount required"),
  /** Required free-form note explaining why — surfaces in the wallet
   *  history so the owner can answer "why did Ahmed get 50 EGP?". */
  reason: z.string().min(2).max(500),
  /** Optional name to seed the wallet's customerName field if absent. */
  customerName: z.string().max(120).optional(),
});

/**
 * Owner-only manual credit grant / deduction. Refused for staff —
 * adjusting customer credit is a financial action that should sit
 * with the owner.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ phone: string }> },
) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  if (r.ctx.role !== "owner") {
    return NextResponse.json(
      { error: "العملية متاحة لصاحب المتجر فقط." },
      { status: 403 },
    );
  }

  const { phone } = await params;
  const normalised = normalizeEgyptPhone(phone);
  if (!normalised) {
    return NextResponse.json({ error: "INVALID_PHONE" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "بيانات غير صالحة" },
      { status: 400 },
    );
  }

  try {
    const result = await grantCredit(
      r.ctx.tenantId,
      r.ctx.branchId,
      normalised,
      parsed.data.amountEgp,
      {
        customerName: parsed.data.customerName ?? null,
        actorUserId: r.ctx.userId,
        reason: parsed.data.reason,
      },
    );
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action:
        parsed.data.amountEgp >= 0 ? "loyalty.credit_grant" : "loyalty.credit_deduct",
      category: "settings",
      branchId: r.ctx.branchId,
      metadata: {
        customerPhone: normalised,
        amountEgp: parsed.data.amountEgp,
        reason: parsed.data.reason,
        newCreditBalance: result.credit,
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "خطأ" },
      { status: 400 },
    );
  }
}
