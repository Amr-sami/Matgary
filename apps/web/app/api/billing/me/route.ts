import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import {
  ensureSubscription,
  listPaymentAttempts,
} from "@/lib/repo/subscriptions";
import { isPaymobConfigured } from "@/lib/payments/paymob";

export async function GET() {
  // A lapsed subscription is exactly when this screen must render — the
  // native /billing route is where SUBSCRIPTION_REQUIRED sends the user.
  const r = await requireTenant({ allowSubscriptionRequired: true });
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
