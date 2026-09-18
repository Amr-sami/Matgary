/**
 * The POS write, as an outbox handler (doc 06 §6.3).
 *
 * One request shape, two callers: sales.tsx sends live through
 * `sendCartSale`, and when it cannot (offline, or a retryable network /
 * server error mid-request) it enqueues the SAME body under the SAME
 * idempotency key — the cart's invoice id — so a half-sent sale replays the
 * server's cached receipt instead of booking a second one (§6.6).
 *
 * The handler adds `X-Outbox-Branch`: the branch the row was rung at. If the
 * cashier has since switched branches the route answers 409 rather than
 * booking the sale at the wrong branch; classify() marks that row failed +
 * actionable and the sync screen tells them to switch back and retry.
 */
import * as Crypto from "expo-crypto";
import { ApiError, sales as salesApi } from "@matgary/api-client";
import { calcLineDiscount, computeCartTotals, type DiscountType } from "@matgary/domain";

import { api } from "@/api/client";
import { classifyOutcome, discard, enqueue, hasHandler, registerHandler, retry, type DrainResult, type OutboxItem } from "@/offline";
import { readMeta, writeMeta } from "@/offline/outbox";
import { useCart, type CartLine } from "@/stores/cart";

export const SALE_KIND = "sale";

/**
 * What an outbox row stores. The wire body (`lines` + `options`) is exactly
 * what the live POST sent; `names` is a CLIENT-ONLY sidecar — product names at
 * ring time, so the sync screen can list the lines and "Edit" can rebuild the
 * cart offline, when the product list is not around. The handler strips it
 * before sending, so a replay is still byte-identical to the live attempt.
 */
export type SalePayload = salesApi.CartSaleBody & { names?: Record<string, string> };
export type SaleOutboxItem = OutboxItem<SalePayload, salesApi.CartSaleResult>;

/** Wire body only — `names` never leaves the device. Key order (lines, options) survives. */
function wireBody(payload: SalePayload): salesApi.CartSaleBody {
  const { names: _names, ...body } = payload;
  return body;
}

/**
 * Register the "sale" handler. Idempotent — call it from every screen that
 * enqueues or triages sales so the handler exists whichever mounts first.
 * Also run at module scope below: expo-router requires every route file at
 * launch, so this module is loaded (and the handler registered) before the
 * launch drain looks at a row.
 */
export function ensureSaleHandler(): void {
  if (hasHandler(SALE_KIND)) return;
  registerHandler<SalePayload, salesApi.CartSaleResult>(SALE_KIND, (payload, idempotencyKey, row) =>
    salesApi.sendCartSale(
      api,
      wireBody(payload),
      idempotencyKey,
      row.branchId ? { "X-Outbox-Branch": row.branchId } : {},
    ),
  );
}

/**
 * Queue a sale for the drainer. The idempotency key IS the invoice id, minted
 * once by the cart store — never regenerated on retry (§6.6). Returns the
 * outbox row id (watch it with useOutbox()). Throws (from the engine) when
 * nobody is signed in or the invoice id is not a valid key.
 */
export function enqueueSale(body: salesApi.CartSaleBody, invoiceId: string, names?: Record<string, string>): string {
  ensureSaleHandler();
  const payload: SalePayload = names ? { ...body, names } : body;
  return enqueue(SALE_KIND, payload, invoiceId);
}

// ─── triage (sync screen) ────────────────────────────────────────────────────

/**
 * Domain refusals the cart route CACHES under the Idempotency-Key for 24h
 * (apps/web/app/api/sales/cart/route.ts catch → rememberResponse for every
 * 4xx domain error). Replaying the same key returns the same refusal even
 * after the shelf was restocked, so "Retry" is a guaranteed no-op for these;
 * the only way forward is Edit → a fresh invoice id (§2.2.4 / doc 06 §6.3).
 */
export const CACHED_REFUSAL_CODES = new Set(["INSUFFICIENT_STOCK", "PRODUCT_NOT_FOUND", "PRODUCT_WRONG_BRANCH", "CART_EMPTY"]);

/**
 * How a failed sale can be retried:
 *  - "same-key": the outcome is unknown (network / timeout / proxy page /
 *    branch mismatch — that 409 is answered before the cache and never
 *    stored), so the ORIGINAL key must be replayed to dedupe (§6.6).
 *  - "rekey": the route's own 500 (`{error:"INTERNAL"}`) means the sale was
 *    rolled back and NOT booked — but the route caches that 500 under the key
 *    too, so a same-key retry receives the cached failure all day. A new
 *    invoice id is the only retry that can succeed, and cannot double-post.
 *  - "edit": a cached domain refusal — retrying cannot help; the cashier must
 *    fix the cart (see CACHED_REFUSAL_CODES).
 */
export type SaleRetryMode = "same-key" | "rekey" | "edit";

export function saleRetryMode(item: OutboxItem): SaleRetryMode {
  const code = item.lastErrorCode;
  if (code && CACHED_REFUSAL_CODES.has(code)) return "edit";
  if (code === "INTERNAL") return "rekey";
  if (code === "MAX_ATTEMPTS" && /INTERNAL/.test(item.lastErrorText ?? "")) return "rekey";
  return "same-key";
}

/** Same shape as stores/cart.ts newInvoiceId (not exported there). */
export function mintInvoiceId(): string {
  return `INV-${Crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
}

/**
 * Retry a failed sale the way its failure allows (saleRetryMode). A re-key
 * discards the old row (its audit copy survives under meta `discard:<id>`,
 * annotated with the new invoice id) and enqueues the same body under a
 * fresh invoice id / Idempotency-Key. Returns the drain result either way.
 */
export function retrySale(item: SaleOutboxItem): Promise<DrainResult> {
  if (saleRetryMode(item) !== "rekey") return retry(item.id);
  const fresh = mintInvoiceId();
  const body: salesApi.CartSaleBody = {
    lines: item.payload.lines,
    options: { ...item.payload.options, invoiceId: fresh },
  };
  if (!discardSale(item.id, null, { rekeyedAs: fresh })) return retry(item.id);
  ensureSaleHandler();
  const payload: SalePayload = item.payload.names ? { ...body, names: item.payload.names } : body;
  enqueue(SALE_KIND, payload, fresh);
  return retry(`${SALE_KIND}_${fresh}`);
}

/**
 * Discard with a reason (§2.2.4 "discard with reason (writes an audit row)").
 * The engine's discard() writes the row copy to meta `discard:<id>`; this
 * annotates that copy with the cashier's reason and any extra facts. Returns
 * false when the row is mid-send (nothing was deleted).
 */
export function discardSale(id: string, reason: string | null, extra: Record<string, unknown> = {}): boolean {
  if (!discard(id)) return false;
  const key = `discard:${id}`;
  const raw = readMeta(key);
  if (!raw) return true;
  try {
    const copy = JSON.parse(raw) as Record<string, unknown>;
    writeMeta(key, JSON.stringify({ ...copy, reason: reason?.trim() || null, ...extra }));
  } catch {
    // The audit copy is not JSON we wrote — leave it untouched.
  }
  return true;
}

/**
 * The spec's third action: discard the failed row (its audit copy survives,
 * annotated with the replacement id), then load it back into the POS cart
 * under a FRESH invoice id. A terminal 4xx
 * means the server did NOT book the sale, so the new key cannot double-post.
 *
 * `products` (when the catalog is loaded) supplies current stock so the ±
 * buttons cap correctly; offline, names come from the payload sidecar and the
 * cap is the rung quantity. Returns the new invoice id, or null when the row
 * is mid-send.
 */
export function loadSaleIntoCart(
  item: SaleOutboxItem,
  products: ReadonlyArray<{ id: string; name: string; quantity: number; price: number }> | undefined,
  unknownName: string,
): string | null {
  const byId = new Map((products ?? []).map((p) => [p.id, p]));
  const names = item.payload.names ?? {};
  const lines: CartLine[] = item.payload.lines.map((l) => {
    const p = byId.get(l.productId);
    return {
      productId: l.productId,
      name: p?.name ?? names[l.productId] ?? unknownName,
      pricePerUnit: l.pricePerUnit,
      quantity: l.quantity,
      available: p ? Math.max(p.quantity, l.quantity) : l.quantity,
      lineDiscountType: (l.lineDiscountType ?? "fixed") as DiscountType,
      lineDiscountValue: l.lineDiscountValue ?? 0,
    };
  });
  const o = item.payload.options ?? {};
  // Discard first: if the row is mid-send nothing is loaded and the cashier's
  // current cart is untouched. Only then replace the cart under the new id.
  const fresh = mintInvoiceId();
  if (!discardSale(item.id, null, { editedAs: fresh })) return null;
  useCart.getState().reset();
  useCart.setState({
    invoiceId: fresh,
    lines,
    orderDiscountType: (o.orderDiscountType ?? "fixed") as DiscountType,
    orderDiscountValue: o.orderDiscountValue ?? 0,
    customerName: o.customerName ?? "",
    customerPhone: o.customerPhone ?? "",
    note: o.note ?? "",
  });
  return fresh;
}

/**
 * Should a live POST that just threw be handed to the outbox instead of shown
 * as an error? Only when the failure is one a retry can fix: the request never
 * reached the server, or the server failed (5xx / 429 / proxy page). Auth,
 * billing, TOTP and every terminal 4xx surface to the cashier as they always
 * did — queuing those would hide a wall behind a "pending" badge.
 */
export function isQueueableFailure(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const outcome = classifyOutcome(err, 1);
  return outcome.kind === "retryable-network" || outcome.kind === "retryable-server";
}

/**
 * Invoice id, total and item count of a queued sale, read from its stored
 * payload with the same math the cart and the server use.
 */
export interface SaleSummary {
  invoiceId: string | null;
  total: number;
  itemCount: number;
  /** One entry per line; `name` is null when neither the sidecar nor the caller knows it. */
  lines: { productId: string; name: string | null; quantity: number; lineTotal: number }[];
  customerName: string | null;
  customerPhone: string | null;
  /** options.customDate — the moment the sale was rung / will be booked under. */
  rungAt: string | null;
}

const EMPTY_SUMMARY: SaleSummary = { invoiceId: null, total: 0, itemCount: 0, lines: [], customerName: null, customerPhone: null, rungAt: null };

export function describeSalePayload(
  payload: SalePayload | null | undefined,
  nameOf?: (productId: string) => string | null | undefined,
): SaleSummary {
  if (!payload || !Array.isArray(payload.lines)) return EMPTY_SUMMARY;
  const totals = computeCartTotals(
    payload.lines.map((l) => ({
      quantity: l.quantity,
      pricePerUnit: l.pricePerUnit,
      lineDiscountType: l.lineDiscountType ?? "fixed",
      lineDiscountValue: l.lineDiscountValue ?? 0,
    })),
    { type: payload.options?.orderDiscountType ?? "fixed", value: payload.options?.orderDiscountValue ?? 0 },
  );
  const names = payload.names ?? {};
  return {
    invoiceId: payload.options?.invoiceId ?? null,
    total: totals.afterOrderDiscount,
    itemCount: payload.lines.reduce((n, l) => n + l.quantity, 0),
    lines: payload.lines.map((l) => ({
      productId: l.productId,
      name: names[l.productId] ?? nameOf?.(l.productId) ?? null,
      quantity: l.quantity,
      lineTotal:
        l.quantity * l.pricePerUnit -
        calcLineDiscount(l.quantity, l.pricePerUnit, l.lineDiscountType ?? "fixed", l.lineDiscountValue ?? 0),
    })),
    customerName: payload.options?.customerName ?? null,
    customerPhone: payload.options?.customerPhone ?? null,
    rungAt: payload.options?.customDate ?? null,
  };
}

ensureSaleHandler();
