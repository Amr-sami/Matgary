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
  return client.request<CartSaleResult>("/api/sales/cart", {
    method: "POST",
    body: { lines, options },
    headers: { "Idempotency-Key": idempotencyKey },
  });
}
