import type { ApiClient } from "../http";

/**
 * The POS write. Body shape read from apps/web/app/api/sales/cart/route.ts.
 *
 * `quantity` here, NOT `quantitySold` — the older POST /api/sales uses the other
 * name for the same field and mixing them is a 400 that typechecking cannot
 * catch.
 */
export interface CartLineInput {
  productId: string;
  quantity: number;
  pricePerUnit: number;
  lineDiscountType?: "percentage" | "fixed";
  lineDiscountValue?: number;
}

export type PaymentMethod = "cash" | "instapay" | "card" | "deferred";

export interface CartOptions {
  note?: string;
  orderDiscountType?: "percentage" | "fixed";
  orderDiscountValue?: number;
  customerName?: string;
  customerPhone?: string;
  paymentMethod?: PaymentMethod;
  /** Client-minted, so a receipt printed offline matches the server record. */
  invoiceId?: string;
  amountPaidNow?: number;
  /**
   * ISO datetime of the moment the sale was rung. The route books
   * `customDate ?? now`, so a sale rung offline at 22:00 and drained at 09:00
   * lands on the day the customer's receipt shows, not the day it synced.
   */
  customDate?: string;
}

/** apps/web/lib/repo/operations.ts — CartSaleResult */
export interface CartSaleResult {
  invoiceId: string;
  saleIds: string[];
  lines: { productId: string; productName: string; quantity: number; lineTotal: number }[];
  total: number;
  paymentMethod: PaymentMethod;
  customerName: string | null;
  customerPhone: string | null;
  note: string | null;
}

/**
 * The exact JSON the cart route receives. Both the live POS write and the
 * offline outbox go through `sendCartSale`, so the two paths send
 * byte-identical bodies — the outbox stores this object with JSON.stringify
 * and parses it back before sending; key order survives that round trip.
 */
export interface CartSaleBody {
  lines: CartLineInput[];
  options: CartOptions;
}

export function buildCartSaleBody(lines: CartLineInput[], options: CartOptions): CartSaleBody {
  return { lines, options };
}

/**
 * POST a prepared body. `extraHeaders` is for the outbox's `X-Outbox-Branch`
 * (apps/web/app/api/sales/cart/route.ts refuses, with a 409, a row rung at a
 * branch the cashier has since switched away from — better than booking it
 * at the wrong branch). Never pass Idempotency-Key here; it is a parameter so
 * it cannot be forgotten.
 */
export async function sendCartSale(
  client: ApiClient,
  body: CartSaleBody,
  idempotencyKey: string,
  extraHeaders: Record<string, string> = {},
): Promise<CartSaleResult> {
  return client.request<CartSaleResult>("/api/sales/cart", {
    method: "POST",
    body,
    headers: { ...extraHeaders, "Idempotency-Key": idempotencyKey },
  });
}

/**
 * Record a sale.
 *
 * `idempotencyKey` is the one thing that makes this safe to retry. The route
 * caches the response for 24h per (tenant, key), so a replay after a dropped
 * connection returns the ORIGINAL result instead of booking the sale twice.
 * This is the only write route with that guarantee — a retried POST
 * /api/expenses creates a duplicate row — which is why the offline outbox
 * (phase 3) is built around this endpoint specifically.
 *
 * 8..64 chars of [A-Za-z0-9_-]; a UUID v4 qualifies.
 */
export async function recordCartSale(
  client: ApiClient,
  lines: CartLineInput[],
  options: CartOptions,
  idempotencyKey: string,
): Promise<CartSaleResult> {
  return sendCartSale(client, buildCartSaleBody(lines, options), idempotencyKey);
}
