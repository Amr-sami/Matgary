import { NextRequest, NextResponse } from "next/server";
import {
  parseMerchantOrderId,
  verifyPaymobHmac,
} from "@/lib/payments/paymob";
import { settleAttempt } from "@/lib/repo/subscriptions";
import { bustUserContextCache } from "@/lib/auth";
import { logActivity } from "@/lib/repo/activity";
import { db } from "@/lib/db";
import { tenantMembers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { PlanKey } from "@/lib/payments/plans";
import { logger } from "@/lib/logger";

// Paymob webhook handler.
//
// Paymob delivers transaction events both as a server-to-server POST and as
// a redirect to the success/failure URL. We accept POST only here — if the
// HMAC verifies, we settle the attempt; otherwise we 401 without doing
// anything. The `hmac` parameter arrives as a query string, not a header.

export const runtime = "nodejs"; // Drizzle/postgres-js — Node only.

export async function POST(req: NextRequest) {
  const url = req.nextUrl;
  const hmac = url.searchParams.get("hmac") ?? "";

  let body: { obj?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const txn = body.obj;
  if (!txn || typeof txn !== "object") {
    return NextResponse.json({ ok: false, error: "missing obj" }, { status: 400 });
  }

  if (!verifyPaymobHmac(txn, hmac)) {
    // Don't echo why we rejected; an attacker shouldn't learn whether HMAC
    // verification or config presence was the failure mode.
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const order = (txn.order ?? {}) as Record<string, unknown>;
  const merchantOrderId = order.merchant_order_id;
  const parsed = parseMerchantOrderId(merchantOrderId);
  if (!parsed) {
    // Webhook for an order we don't recognise — log and accept (200) so
    // Paymob doesn't keep retrying. Record at console-level for debugging.
    logger.warn({
      event: "paymob.webhook.unknown_order",
      merchantOrderId: String(merchantOrderId),
    });
    return NextResponse.json({ ok: true, ignored: true });
  }

  const success = txn.success === true;
  const amountCents = Number(txn.amount_cents ?? 0);
  const amountEgp = amountCents / 100;
  const transactionId = String(txn.id ?? "");
  const paymobOrderId = String(order.id ?? "");

  await settleAttempt({
    tenantId: parsed.tenantId,
    planKey: parsed.planKey as PlanKey,
    paymobOrderId,
    paymobTransactionId: transactionId,
    amountEgp,
    success,
    failureReason: success
      ? null
      : (typeof txn.data === "object" && txn.data
          ? String((txn.data as Record<string, unknown>).message ?? "")
          : null) || null,
    rawPayload: txn,
  });

  // Drop the cached subscription view for every member of the tenant so the
  // next page load reflects the new state immediately (no 60s stale window).
  try {
    const members = await db
      .select({ userId: tenantMembers.userId })
      .from(tenantMembers)
      .where(eq(tenantMembers.tenantId, parsed.tenantId));
    await Promise.all(members.map((m) => bustUserContextCache(m.userId)));
  } catch (err) {
    logger.warn({
      event: "paymob.webhook.cache_bust_failed",
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  logActivity({
    tenantId: parsed.tenantId,
    actorUserId: null,
    actorName: "Paymob",
    action: success ? "billing.payment_succeeded" : "billing.payment_failed",
    category: "settings",
    metadata: {
      plan: parsed.planKey,
      amountEgp,
      paymobOrderId,
      paymobTransactionId: transactionId,
    },
  });

  return NextResponse.json({ ok: true });
}
