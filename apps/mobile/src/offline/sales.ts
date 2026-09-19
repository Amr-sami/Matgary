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
import { ApiError, sales as salesApi } from "@matgary/api-client";
import { calcLineDiscount, computeCartTotals, type DiscountType } from "@matgary/domain";

import { api } from "@/api/client";
import { classifyOutcome, discard, enqueue, hasHandler, registerHandler, retry, type DrainResult, type OutboxItem } from "@/offline";
import { isSimulatedOffline } from "@/offline/dev-offline";
import { mintInvoiceId } from "@/offline/invoice-id";
import { get as getRow, readMeta, replacePayload, writeMeta } from "@/offline/outbox";
import { useCart, type CartLine } from "@/stores/cart";
import { useSession } from "@/stores/session";

export const SALE_KIND = "sale";

/**
 * What an outbox row stores. The wire body (`lines` + `options`) is exactly
 * what the live POST sent; `names` and `catalogUpdatedAt` are CLIENT-ONLY
 * sidecars — product names at ring time, so the sync screen can list the
 * lines and "Edit" can rebuild the cart offline, when the product list is
 * not around; and the catalogue's `updatedAt` per product as the POS saw it
 * when the sale was rung, which localDelta (§6.5) uses to tell "the server
 * still shows what we rang against" from "the server moved this product
 * since" without ever comparing a device clock to a server clock. The
 * handler strips both before sending, so a replay is still byte-identical
 * to the live attempt.
 */
export type SalePayload = salesApi.CartSaleBody & {
  names?: Record<string, string>;
  catalogUpdatedAt?: Record<string, string>;
  /**
   * §6.5 / S7 "sell anyway": `options.allowOversell: true` books the sale
   * even though stock is short — the server drives the quantity to the floor
   * and writes a stock-discrepancy audit row (product_history). Sent on the
   * wire inside `options`; the cart route's zod schema accepts it (S7).
   */
  options: salesApi.CartOptions;
};
export type SaleOutboxItem = OutboxItem<SalePayload, salesApi.CartSaleResult>;

/** Wire body only — the sidecars never leave the device. Key order (lines, options) survives. */
function wireBody(payload: SalePayload): salesApi.CartSaleBody {
  const { names: _names, catalogUpdatedAt: _stamps, ...body } = payload;
  return body;
}

/** The client-only sidecars of a payload, to carry over to a replacement row. */
function sidecarOf(payload: SalePayload): Pick<SalePayload, "names" | "catalogUpdatedAt"> {
  return {
    ...(payload.names ? { names: payload.names } : {}),
    ...(payload.catalogUpdatedAt ? { catalogUpdatedAt: payload.catalogUpdatedAt } : {}),
  };
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
  registerHandler<SalePayload, salesApi.CartSaleResult>(SALE_KIND, (payload, idempotencyKey, row) => {
    // DEV-ONLY simulate-offline: behave exactly like a request that never
    // reached the server (classify → retryable-network → backoff). The
    // drainer already skips whole passes while the switch is on; this covers
    // a pass that was mid-flight when it flipped.
    if (__DEV__ && isSimulatedOffline()) {
      return Promise.reject(new ApiError({ kind: "offline", message: "simulated offline (dev switch)" }));
    }
    return salesApi.sendCartSale(
      api,
      wireBody(payload),
      idempotencyKey,
      row.branchId ? { "X-Outbox-Branch": row.branchId } : {},
    );
  });
}

/**
 * Queue a sale for the drainer. The idempotency key IS the invoice id, minted
 * once by the cart store — never regenerated on retry (§6.6). Returns the
 * outbox row id (watch it with useOutbox()). Throws (from the engine) when
 * nobody is signed in or the invoice id is not a valid key.
 */
export function enqueueSale(
  body: salesApi.CartSaleBody,
  invoiceId: string,
  names?: Record<string, string>,
  catalogUpdatedAt?: Record<string, string>,
): string {
  ensureSaleHandler();
  const payload: SalePayload = {
    ...body,
    ...(names ? { names } : {}),
    ...(catalogUpdatedAt ? { catalogUpdatedAt } : {}),
  };
  return enqueue(SALE_KIND, payload, invoiceId);
}

// ─── triage (sync screen) ────────────────────────────────────────────────────

/**
 * Domain refusals for which a plain "Retry" is pointless: the cart route
 * re-evaluates the same body and refuses it the same way (since S7 the
 * route caches 2xx ONLY, so the key itself is not poisoned — a retry under
 * the same key with a corrected body CAN succeed; that is what sellAnyway
 * does). The way forward is Edit → fix the cart (§2.2.4 / doc 06 §6.3), or
 * Sell anyway for INSUFFICIENT_STOCK (§6.5).
 */
export const CACHED_REFUSAL_CODES = new Set(["INSUFFICIENT_STOCK", "PRODUCT_NOT_FOUND", "PRODUCT_WRONG_BRANCH", "CART_EMPTY"]);

/**
 * How a failed sale can be retried:
 *  - "same-key": the outcome is unknown (network / timeout / proxy page /
 *    branch mismatch — that 409 is answered before the cache and never
 *    stored), so the ORIGINAL key must be replayed to dedupe (§6.6).
 *  - "rekey": the route's own 500 (`{error:"INTERNAL"}`) means the sale was
 *    rolled back and NOT booked. Since S7 the route no longer caches
 *    failures, so a same-key retry would also work; re-keying is kept as the
 *    belt-and-braces path (it cannot double-post either).
 *  - "edit": a domain refusal — retrying the same body cannot help; the
 *    cashier must fix the cart (see CACHED_REFUSAL_CODES).
 */
export type SaleRetryMode = "same-key" | "rekey" | "edit";

export function saleRetryMode(item: OutboxItem): SaleRetryMode {
  const code = item.lastErrorCode;
  if (code && CACHED_REFUSAL_CODES.has(code)) return "edit";
  if (code === "INTERNAL") return "rekey";
  if (code === "MAX_ATTEMPTS" && /INTERNAL/.test(item.lastErrorText ?? "")) return "rekey";
  return "same-key";
}

export { mintInvoiceId };

/**
 * Codes for which the resolution sheet offers "Sell anyway" (§6.5): the
 * customer already left with the goods, so the right business answer is to
 * book the sale and flag a discrepancy, not to refuse it. PRODUCT_NOT_FOUND
 * is NOT here — a deleted product cannot be booked at all; the sheet offers
 * Edit (re-map the line) / Discard for it.
 */
export const OVERSELL_CODES: ReadonlySet<string> = new Set(["INSUFFICIENT_STOCK"]);

/**
 * Feature flag for the §6.5 "Sell anyway" ACTION. S7 landed server-side:
 * apps/web/app/api/sales/cart/route.ts accepts `options.allowOversell`,
 * recordCartSale floors the stock at 0 and appends a discrepancy row to
 * product_history, and the route caches 2xx only — so a same-key retry with
 * the flag succeeds (verified live against :3003). Kept as a constant so the
 * action can be switched off in one place if the server ever regresses.
 */
export const SELL_ANYWAY_ENABLED: boolean = true;

/** A failed sale the server refused for short stock — the §6.5 case, whether or not the action is offered. */
export function isOversellRefusal(item: OutboxItem): boolean {
  return item.kind === SALE_KIND && item.status === "failed" && !!item.lastErrorCode && OVERSELL_CODES.has(item.lastErrorCode);
}

export function canSellAnyway(item: OutboxItem): boolean {
  return SELL_ANYWAY_ENABLED && isOversellRefusal(item);
}

/**
 * "Sell anyway": re-submit the refused sale with `allowOversell: true` under
 * the SAME Idempotency-Key (S7). The route caches 2xx only, so the key is
 * clean after a refusal and the server evaluates the corrected body afresh;
 * and if the original DID land (a lost 201), the same key replays the cached
 * receipt instead of booking twice (§6.6). The invoice id and key never
 * change, so the receipt the customer holds matches the server record.
 *
 * The row is swapped IN PLACE (outbox.replacePayload): its pre-swap copy is
 * written to meta `discard:<id>` (annotated `soldAnywayAs` / `allowOversell`)
 * and the payload, status and attempts are rewritten in the SAME SQLite
 * transaction — the sale is never absent from the outbox, not even across a
 * crash between two writes (§6.6 "a sale must never disappear"). Refuses
 * with a reason instead of writing anything when the row is mid-send (or
 * gone) or nobody is signed in — the two need different copy on screen.
 */
export type SellAnywayRefusal = "mid-send" | "signed-out";

export function sellAnyway(item: SaleOutboxItem): Promise<DrainResult> | SellAnywayRefusal {
  if (!useSession.getState().me) return "signed-out";
  if (isMidSend(item.id)) return "mid-send";
  const key = item.idempotencyKey;
  const invoiceId = item.payload.options?.invoiceId ?? key;
  const payload: SalePayload = {
    lines: item.payload.lines,
    options: { ...item.payload.options, invoiceId, allowOversell: true },
    ...sidecarOf(item.payload),
  };
  ensureSaleHandler();
  if (!replacePayload(item.id, payload, { reason: "oversell", soldAnywayAs: key, allowOversell: true })) return "mid-send";
  return retry(item.id);
}

/** True when the row is being sent right now (or is gone) — nothing may replace it then. */
function isMidSend(id: string): boolean {
  const live = getRow(id);
  return !live || live.status === "sending";
}

/**
 * Retry a failed sale the way its failure allows (saleRetryMode). A re-key
 * enqueues the same body under a fresh invoice id / Idempotency-Key FIRST
 * and only then discards the old row (its audit copy survives under meta
 * `discard:<id>`, annotated with the new invoice id) — enqueue first so
 * the sale is never absent from the outbox between the two writes (§6.6);
 * a fresh key cannot collide, which is what makes that order possible
 * (sellAnyway keeps the key and so swaps in place instead). A row that is
 * mid-send is retried under its own key
 * instead. Returns the drain result either way.
 */
export function retrySale(item: SaleOutboxItem): Promise<DrainResult> {
  if (saleRetryMode(item) !== "rekey" || isMidSend(item.id)) return retry(item.id);
  const fresh = mintInvoiceId();
  const payload: SalePayload = {
    lines: item.payload.lines,
    options: { ...item.payload.options, invoiceId: fresh },
    ...sidecarOf(item.payload),
  };
  ensureSaleHandler();
  enqueue(SALE_KIND, payload, fresh);
  discardSale(item.id, null, { rekeyedAs: fresh });
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
  // Discard first — the opposite order from retrySale, on purpose:
  // the target here is the in-memory cart store (a plain setState that cannot
  // throw), so nothing can be lost between the two steps, whereas loading the
  // cart BEFORE a discard that then refuses (row mid-send) would leave the
  // cashier holding a second copy of a sale that is still being booked.
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
