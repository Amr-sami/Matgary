import { and, desc, eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { paymentAttempts, subscriptions } from "@/lib/db/schema";
import type { SubscriptionRow, PaymentAttemptRow } from "@/lib/db/schema";
import {
  PAYMENT_GRACE_DAYS,
  PLANS,
  type PlanKey,
  trialEndsFromNow,
} from "@/lib/payments/plans";

// Subscription state machine helpers. We touch this table from three places:
//
//  1. signup            → ensureSubscription(tenantId) creates the trial row.
//  2. /billing checkout → markPending() + a payment_attempt placeholder.
//  3. paymob webhook    → settleAttempt(succeeded|failed) updates everything.
//
// All reads go through the cached view (resolveSubscription); the JWT-callback
// cache (lib/auth.ts) is invalidated whenever status changes.

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "cancelled"
  | "expired";

export interface SubscriptionDto {
  tenantId: string;
  plan: PlanKey;
  status: SubscriptionStatus;
  trialEndsAt: Date;
  currentPeriodEndsAt: Date | null;
  cancelledAt: Date | null;
  amountEgp: number | null;
  /** True when the tenant should still have full access right now. */
  isAccessActive: boolean;
  daysLeftInTrial: number | null;
}

function rowToDto(row: SubscriptionRow): SubscriptionDto {
  const status = row.status as SubscriptionStatus;
  const now = Date.now();
  const trialEnd = row.trialEndsAt.getTime();
  const periodEnd = row.currentPeriodEndsAt?.getTime() ?? null;

  // "Access active" is the truth function the middleware reads. We grant
  // access while:
  //   - trialing AND inside the trial window
  //   - active AND inside the current period
  //   - past_due AND inside the 7-day grace
  //   - cancelled AND still inside the period the user paid for
  let isAccessActive = false;
  if (status === "trialing" && trialEnd > now) isAccessActive = true;
  else if (status === "active" && periodEnd != null && periodEnd > now)
    isAccessActive = true;
  else if (status === "past_due" && periodEnd != null) {
    const grace = periodEnd + PAYMENT_GRACE_DAYS * 24 * 60 * 60 * 1000;
    if (grace > now) isAccessActive = true;
  } else if (status === "cancelled" && periodEnd != null && periodEnd > now)
    isAccessActive = true;

  let daysLeftInTrial: number | null = null;
  if (status === "trialing") {
    const ms = Math.max(0, trialEnd - now);
    daysLeftInTrial = Math.ceil(ms / (24 * 60 * 60 * 1000));
  }

  return {
    tenantId: row.tenantId,
    plan: row.plan as PlanKey,
    status,
    trialEndsAt: row.trialEndsAt,
    currentPeriodEndsAt: row.currentPeriodEndsAt ?? null,
    cancelledAt: row.cancelledAt ?? null,
    amountEgp: row.amountEgp ? Number(row.amountEgp) : null,
    isAccessActive,
    daysLeftInTrial,
  };
}

/**
 * Idempotent: creates the trial row if missing. Called from signup and from
 * the middleware as a safety net for legacy tenants that pre-date this code.
 */
export async function ensureSubscription(tenantId: string): Promise<SubscriptionDto> {
  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, tenantId))
      .limit(1);
    if (existing) return rowToDto(existing);

    const [created] = await tx
      .insert(subscriptions)
      .values({
        tenantId,
        plan: "trial",
        status: "trialing",
        trialEndsAt: trialEndsFromNow(),
      })
      .returning();
    return rowToDto(created);
  });
}

export async function getSubscription(
  tenantId: string,
): Promise<SubscriptionDto | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, tenantId))
      .limit(1);
    return row ? rowToDto(row) : null;
  });
}

/**
 * Edge-runtime variant: we cannot use `withTenant` in middleware because it
 * runs Drizzle, which pulls postgres-js (Node-only). The middleware reaches
 * for Postgres directly via a global pool? — no, we keep middleware purely
 * about JWT + cache, and gate trial expiration via JWT claims set in the
 * jwt callback. This helper is the writer side; the middleware just reads
 * the claim.
 */
export async function recordPendingAttempt(input: {
  tenantId: string;
  paymobOrderId: string;
  amountEgp: number;
}): Promise<{ id: string }> {
  return withTenant(input.tenantId, async (tx) => {
    const [row] = await tx
      .insert(paymentAttempts)
      .values({
        tenantId: input.tenantId,
        paymobOrderId: input.paymobOrderId,
        amountEgp: String(input.amountEgp),
        status: "pending",
      })
      .returning({ id: paymentAttempts.id });
    return { id: row.id };
  });
}

export interface SettleInput {
  tenantId: string;
  planKey: PlanKey;
  paymobOrderId: string;
  paymobTransactionId: string;
  amountEgp: number;
  /** True = success path, False = failure path. */
  success: boolean;
  failureReason?: string | null;
  rawPayload: Record<string, unknown>;
}

/**
 * Idempotent settlement of a Paymob transaction. The unique paymob txn id is
 * the dedupe key — Paymob occasionally re-delivers a webhook, and we'd rather
 * silently noop on the second one than upgrade a paid month into two.
 */
export async function settleAttempt(input: SettleInput): Promise<void> {
  await withTenant(input.tenantId, async (tx) => {
    // 1. Look up by transaction id; if we already saw it, return.
    const [existing] = await tx
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.tenantId, input.tenantId),
          eq(paymentAttempts.paymobTransactionId, input.paymobTransactionId),
        ),
      )
      .limit(1);
    if (existing && existing.status !== "pending") {
      return; // Already settled — webhook redelivery, skip.
    }

    // 2. Find the matching pending attempt (registered when checkout started).
    const [pending] = await tx
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.tenantId, input.tenantId),
          eq(paymentAttempts.paymobOrderId, input.paymobOrderId),
          eq(paymentAttempts.status, "pending"),
        ),
      )
      .orderBy(desc(paymentAttempts.attemptedAt))
      .limit(1);

    const newStatus = input.success ? "succeeded" : "failed";
    const settledAt = new Date();

    if (pending) {
      await tx
        .update(paymentAttempts)
        .set({
          status: newStatus,
          paymobTransactionId: input.paymobTransactionId,
          failureReason: input.failureReason ?? null,
          rawPayload: input.rawPayload,
          settledAt,
        })
        .where(eq(paymentAttempts.id, pending.id));
    } else {
      // Webhook arrived without a matching pending row (server restart, etc).
      // Insert a settled row directly so payment history is complete.
      await tx.insert(paymentAttempts).values({
        tenantId: input.tenantId,
        paymobOrderId: input.paymobOrderId,
        paymobTransactionId: input.paymobTransactionId,
        amountEgp: String(input.amountEgp),
        status: newStatus,
        failureReason: input.failureReason ?? null,
        rawPayload: input.rawPayload,
        settledAt,
      });
    }

    // 3. Update subscription state.
    if (input.success) {
      const periodStart = new Date();
      const periodEnd = new Date(periodStart);
      periodEnd.setMonth(periodEnd.getMonth() + 1);
      const planAmount = PLANS[input.planKey]?.monthlyEgp ?? input.amountEgp;
      await tx
        .update(subscriptions)
        .set({
          plan: input.planKey,
          status: "active",
          currentPeriodStart: periodStart,
          currentPeriodEndsAt: periodEnd,
          paymobLastOrderId: input.paymobOrderId,
          amountEgp: String(planAmount),
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.tenantId, input.tenantId));
    } else {
      // Failed payment — only flip to past_due if the tenant was already on
      // an active paid plan. A failed first payment should leave them in
      // 'trialing' so they can retry without losing access.
      const [sub] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.tenantId, input.tenantId))
        .limit(1);
      if (sub && sub.status === "active") {
        await tx
          .update(subscriptions)
          .set({ status: "past_due", updatedAt: new Date() })
          .where(eq(subscriptions.tenantId, input.tenantId));
      }
    }
  });
}

export async function listPaymentAttempts(
  tenantId: string,
  limit = 30,
): Promise<PaymentAttemptRow[]> {
  return withTenant(tenantId, async (tx) => {
    return tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.tenantId, tenantId))
      .orderBy(desc(paymentAttempts.attemptedAt))
      .limit(limit);
  });
}

/**
 * Owner cancels — keep them on the plan until end of paid period; flip status
 * so the renewal logic doesn't auto-charge again.
 */
export async function cancelSubscription(tenantId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(subscriptions)
      .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(subscriptions.tenantId, tenantId));
  });
}

// Re-exported just so the activity log import path stays flat.
export type { PaymentAttemptRow };

