import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import {
  ensureSubscription,
  listPaymentAttempts,
} from "@/lib/repo/subscriptions";
import { isPaymobConfigured } from "@/lib/payments/paymob";

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;

  const sub = await ensureSubscription(r.ctx.tenantId);
  const history = await listPaymentAttempts(r.ctx.tenantId, 30);

  return NextResponse.json({
    ...sub,
    paymobConfigured: isPaymobConfigured(),
    history: history.map((h) => ({
      id: h.id,
      paymobOrderId: h.paymobOrderId,
      amountEgp: h.amountEgp,
      status: h.status,
      failureReason: h.failureReason,
      attemptedAt: h.attemptedAt,
      settledAt: h.settledAt,
    })),
  });
}
