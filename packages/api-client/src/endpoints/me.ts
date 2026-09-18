import type { ApiClient } from "../http";
import type { MeResponse } from "../types";

/**
 * Identity, tenant, active branch, switchable branches and EFFECTIVE
 * permissions in one call — the app's session bootstrap.
 */
export async function getMe(client: ApiClient): Promise<MeResponse> {
  return client.request<MeResponse>("/api/v1/me");
}

// ---------------------------------------------------------------------------
// Billing — the owner's subscription, the sellable plans and the Paymob
// checkout hand-off. Lives next to /me because /api/billing/me is the one
// other read the server answers under the SUBSCRIPTION_REQUIRED wall.
// ---------------------------------------------------------------------------

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "cancelled"
  | "expired";

export type PaymentAttemptStatus = "pending" | "succeeded" | "failed";

/** One row of the tenant's Paymob attempt log (newest first, ≤30). */
export interface PaymentAttempt {
  id: string;
  paymobOrderId: string | null;
  amountEgp: number;
  status: PaymentAttemptStatus | string;
  failureReason: string | null;
  /** ISO. */
  attemptedAt: string;
  /** ISO; null while pending. */
  settledAt: string | null;
}

/**
 * GET /api/billing/me — the subscription row spread flat, plus whether the
 * server has Paymob credentials at all (`paymobConfigured=false` means the
 * subscribe route answers 503 and the app must not offer checkout).
 */
export interface BillingMe {
  tenantId: string;
  plan: string;
  status: SubscriptionStatus | string;
  trialEndsAt: string | null;
  currentPeriodEndsAt: string | null;
  cancelledAt: string | null;
  /** null for legacy/trial rows (rowToDto: `row.amountEgp ? Number(...) : null`). */
  amountEgp: number | null;
  isAccessActive: boolean;
  daysLeftInTrial: number | null;
  paymobConfigured: boolean;
  history: PaymentAttempt[];
}

/**
 * GET /api/plans (public) — platform_plans as edited at /admin/plans. Both
 * languages ride side by side; the caller picks the sibling for its locale.
 */
export interface BillingPlan {
  key: string;
  labelAr: string;
  labelEn: string;
  taglineAr: string;
  taglineEn: string;
  monthlyEgp: number;
  purchasable: boolean;
  featuresAr: string[];
  featuresEn: string[];
}

/** The only plan `POST /api/billing/subscribe` accepts today (zod enum). */
export type PurchasablePlanKey = "professional";

export async function getBilling(client: ApiClient): Promise<BillingMe> {
  return client.request<BillingMe>("/api/billing/me");
}

export async function listPlans(client: ApiClient): Promise<BillingPlan[]> {
  const res = await client.request<{ data: BillingPlan[] }>("/api/plans", {
    auth: false,
  });
  return res.data;
}

/**
 * POST /api/billing/subscribe — runs the 3-step Paymob handshake server-side
 * and returns the HOSTED checkout page (`accept.paymob.com/…/iframes/<id>?
 * payment_token=…`). The web sets `window.location.href` to it; a native
 * client opens it in the system browser. Paymob bounces the user back to the
 * configured success/failure URL and the webhook settles the attempt, so the
 * caller must re-read `getBilling` when the app regains focus.
 *
 * Owner-only (403 otherwise); 503 while `PAYMOB_*` is unset; 502 when Paymob
 * itself refused.
 */
export async function startCheckout(
  client: ApiClient,
  // `string & {}` keeps the literal for autocomplete while letting the plan
  // list (server data) drive what is offered — the route 400s an unknown key.
  plan: PurchasablePlanKey | (string & {}),
): Promise<{ iframeUrl: string }> {
  return client.request<{ iframeUrl: string }>("/api/billing/subscribe", {
    method: "POST",
    body: { plan },
  });
}
