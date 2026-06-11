import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireTenant } from "@/lib/api/auth-helpers";
import { db } from "@/lib/db";
import { tenants, tenantMembers, users } from "@/lib/db/schema";
import {
  createCheckout,
  isPaymobConfigured,
} from "@/lib/payments/paymob";
import { PLANS, type PlanKey } from "@/lib/payments/plans";
import { getPlan } from "@/lib/plans";
import {
  ensureSubscription,
  recordPendingAttempt,
} from "@/lib/repo/subscriptions";
import { logActivity } from "@/lib/repo/activity";

const schema = z.object({
  plan: z.enum(["professional"] as const),
});

export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  // Only owners can subscribe — staff have no business spending the shop's money.
  if (r.ctx.role !== "owner") {
    return NextResponse.json(
      { error: "العملية متاحة لصاحب المتجر فقط." },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }

  if (!isPaymobConfigured()) {
    return NextResponse.json(
      {
        error:
          "بوابة الدفع غير مهيأة بعد. سيتم تفعيلها قريباً — راسلنا للترقية يدوياً.",
      },
      { status: 503 },
    );
  }

  const planKey = parsed.data.plan as PlanKey;
  // Spec 04: pull plan price + purchasable from the DB (via getPlan) so an
  // admin edit at /admin/plans takes effect on the very next signup. PLANS
  // is the typed fallback when the DB read fails — same structural shape.
  const dbPlan = await getPlan(planKey);
  const planAmount =
    dbPlan?.monthlyEgp ?? PLANS[planKey]?.monthlyEgp ?? 0;
  const planPurchasable =
    dbPlan?.purchasable ?? PLANS[planKey]?.purchasable ?? false;
  if (!planPurchasable || planAmount <= 0) {
    return NextResponse.json({ error: "باقة غير صالحة" }, { status: 400 });
  }

  // Make sure a subscription row exists (handles legacy tenants that signed
  // up before the billing tables existed).
  await ensureSubscription(r.ctx.tenantId);

  // Look up tenant + actor info Paymob's billing form requires.
  const [tenant] = await db
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, r.ctx.tenantId))
    .limit(1);
  const [actor] = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, r.ctx.userId))
    .limit(1);
  const [member] = await db
    .select({ phone: tenantMembers.phone, displayName: tenantMembers.displayName })
    .from(tenantMembers)
    .where(eq(tenantMembers.userId, r.ctx.userId))
    .limit(1);

  const result = await createCheckout({
    tenantId: r.ctx.tenantId,
    amountEgp: planAmount,
    planKey,
    customer: {
      email: actor?.email ?? "no-reply@matgary.local",
      firstName: member?.displayName ?? actor?.name ?? tenant?.name ?? "Customer",
      lastName: tenant?.name ?? "Matgary",
      phone: member?.phone ?? "+201000000000",
    },
  });

  if (!result.ok) {
    const reason =
      result.error.kind === "not_configured"
        ? "بوابة الدفع غير مهيأة بعد."
        : "تعذر فتح صفحة الدفع، حاول لاحقاً.";
    console.warn("[billing] paymob createCheckout failed:", result.error);
    return NextResponse.json({ error: reason }, { status: 502 });
  }

  await recordPendingAttempt({
    tenantId: r.ctx.tenantId,
    paymobOrderId: result.paymobOrderId,
    amountEgp: planAmount,
  });

  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "billing.checkout_started",
    category: "settings",
    metadata: { plan: planKey, amountEgp: planAmount },
  });

  return NextResponse.json({ iframeUrl: result.iframeUrl });
}
