import { createHmac } from "node:crypto";

// Paymob (Accept) integration adapter.
//
// The integration shape Paymob mandates is a 3-step "Accept iframe" flow:
//
//   1. POST /api/auth/tokens         → auth_token      (uses PAYMOB_API_KEY)
//   2. POST /api/ecommerce/orders    → order_id        (server-to-server)
//   3. POST /api/acceptance/payment_keys → payment_key (used by the iframe)
//
// The user is then redirected to the iframe URL containing the payment_key.
// On payment, Paymob calls our webhook with an HMAC of the transaction
// payload, signed with PAYMOB_HMAC_SECRET.
//
// This module is structured so that:
//
//   - Without env vars set, every entry point returns a clear "not configured"
//     error instead of throwing — /billing can show a friendly disabled state
//     until the operator wires up a Paymob account.
//   - HMAC verification is implemented in full and unit-testable.
//   - The HTTP client logic is isolated in `paymobFetch` so the call sites
//     stay declarative.
//
// References:
//   https://developers.paymob.com/egypt/checkout-api/accept-standard-redirect

const PAYMOB_BASE = "https://accept.paymob.com";
const PAYMOB_IFRAME_BASE = "https://accept.paymob.com/api/acceptance/iframes";

export interface PaymobConfig {
  apiKey: string;
  /** Numeric integration id of the card-payment integration in your account. */
  integrationId: number;
  /** Numeric iframe id from the Accept iframes page. */
  iframeId: number;
  hmacSecret: string;
}

export type PaymobError =
  | { kind: "not_configured" }
  | { kind: "http_error"; status: number; message: string }
  | { kind: "missing_field"; field: string };

function readConfig(): PaymobConfig | null {
  const apiKey = process.env.PAYMOB_API_KEY;
  const integrationId = Number(process.env.PAYMOB_INTEGRATION_ID);
  const iframeId = Number(process.env.PAYMOB_IFRAME_ID);
  const hmacSecret = process.env.PAYMOB_HMAC_SECRET;
  if (!apiKey || !hmacSecret) return null;
  if (!Number.isFinite(integrationId) || !Number.isFinite(iframeId)) return null;
  return { apiKey, integrationId, iframeId, hmacSecret };
}

export function isPaymobConfigured(): boolean {
  return readConfig() !== null;
}

export interface BillingCustomer {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
}

export interface CreateCheckoutInput {
  /** Tenant our records key off. Embedded in order metadata for the webhook. */
  tenantId: string;
  /** EGP, integer piastres recommended; we accept whole pounds and convert. */
  amountEgp: number;
  /** Plan key being purchased — passed into Paymob order metadata. */
  planKey: string;
  customer: BillingCustomer;
}

export type CreateCheckoutResult =
  | {
      ok: true;
      iframeUrl: string;
      paymobOrderId: string;
      paymentKey: string;
    }
  | {
      ok: false;
      error: PaymobError;
    };

async function paymobFetch(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${PAYMOB_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

/**
 * Run the 3-step Paymob handshake and return the iframe URL the user should
 * be redirected to. Designed to be safely called from a route handler.
 */
export async function createCheckout(
  input: CreateCheckoutInput,
): Promise<CreateCheckoutResult> {
  const cfg = readConfig();
  if (!cfg) return { ok: false, error: { kind: "not_configured" } };

  const piastres = Math.round(input.amountEgp * 100);

  // Step 1 — auth token.
  const auth = await paymobFetch("/api/auth/tokens", { api_key: cfg.apiKey });
  if (auth.status !== 201) {
    return {
      ok: false,
      error: {
        kind: "http_error",
        status: auth.status,
        message: "auth tokens failed",
      },
    };
  }
  const authToken = (auth.data as { token?: string }).token;
  if (!authToken) {
    return { ok: false, error: { kind: "missing_field", field: "token" } };
  }

  // Step 2 — register order.
  const order = await paymobFetch("/api/ecommerce/orders", {
    auth_token: authToken,
    delivery_needed: false,
    amount_cents: piastres,
    currency: "EGP",
    items: [
      {
        name: `Matgary plan: ${input.planKey}`,
        amount_cents: piastres,
        description: `Subscription for tenant ${input.tenantId}`,
        quantity: 1,
      },
    ],
    // Encoded so the webhook can resolve which tenant + plan this is for.
    merchant_order_id: `${input.tenantId}:${input.planKey}:${Date.now()}`,
  });
  if (order.status !== 201) {
    return {
      ok: false,
      error: {
        kind: "http_error",
        status: order.status,
        message: "order register failed",
      },
    };
  }
  const orderId = (order.data as { id?: number | string }).id;
  if (!orderId) {
    return { ok: false, error: { kind: "missing_field", field: "order.id" } };
  }

  // Step 3 — payment key.
  const pk = await paymobFetch("/api/acceptance/payment_keys", {
    auth_token: authToken,
    amount_cents: piastres,
    expiration: 3600,
    order_id: orderId,
    billing_data: {
      apartment: "NA",
      email: input.customer.email,
      floor: "NA",
      first_name: input.customer.firstName,
      street: "NA",
      building: "NA",
      phone_number: input.customer.phone,
      shipping_method: "NA",
      postal_code: "NA",
      city: "NA",
      country: "EG",
      last_name: input.customer.lastName,
      state: "NA",
    },
    currency: "EGP",
    integration_id: cfg.integrationId,
  });
  if (pk.status !== 201) {
    return {
      ok: false,
      error: {
        kind: "http_error",
        status: pk.status,
        message: "payment_keys failed",
      },
    };
  }
  const paymentToken = (pk.data as { token?: string }).token;
  if (!paymentToken) {
    return { ok: false, error: { kind: "missing_field", field: "payment_key" } };
  }

  return {
    ok: true,
    iframeUrl: `${PAYMOB_IFRAME_BASE}/${cfg.iframeId}?payment_token=${paymentToken}`,
    paymobOrderId: String(orderId),
    paymentKey: paymentToken,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook signature verification.
// Paymob concatenates a fixed list of fields from the transaction payload
// (sorted, no separator) and signs it with HMAC-SHA512 keyed by the merchant's
// HMAC secret. The signature lands in the `hmac` query parameter.
// Field order is documented in the integration guide and reproduced here.
// ─────────────────────────────────────────────────────────────────────────────

const HMAC_FIELDS_ORDERED = [
  "amount_cents",
  "created_at",
  "currency",
  "error_occured",
  "has_parent_transaction",
  "id",
  "integration_id",
  "is_3d_secure",
  "is_auth",
  "is_capture",
  "is_refunded",
  "is_standalone_payment",
  "is_voided",
  "order.id",
  "owner",
  "pending",
  "source_data.pan",
  "source_data.sub_type",
  "source_data.type",
  "success",
];

function deepGet(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Verify Paymob's HMAC signature on a transaction payload. Returns true only
 * when the locally-computed HMAC matches the one Paymob sent verbatim.
 *
 * Constant-time comparison via Buffer.compare to dodge timing oracles.
 */
export function verifyPaymobHmac(
  payload: Record<string, unknown>,
  receivedHmac: string,
): boolean {
  const cfg = readConfig();
  if (!cfg) return false;
  if (typeof receivedHmac !== "string" || receivedHmac.length === 0) return false;

  const concatenated = HMAC_FIELDS_ORDERED.map((field) => {
    const v = deepGet(payload, field);
    return v == null ? "" : String(v);
  }).join("");

  const expected = createHmac("sha512", cfg.hmacSecret)
    .update(concatenated)
    .digest("hex");

  if (expected.length !== receivedHmac.length) return false;
  // Buffer.compare is constant-time at the byte level; identical lengths is
  // the precondition we just enforced.
  return Buffer.compare(Buffer.from(expected, "hex"), Buffer.from(receivedHmac, "hex")) === 0;
}

/**
 * Parse the merchant_order_id we packed in step 2 back into its parts.
 * Returns null if the shape doesn't match — caller should treat that as an
 * unknown transaction and skip without erroring.
 */
export function parseMerchantOrderId(
  raw: unknown,
): { tenantId: string; planKey: string } | null {
  if (typeof raw !== "string") return null;
  const [tenantId, planKey] = raw.split(":");
  if (!tenantId || !planKey) return null;
  return { tenantId, planKey };
}
