"use client";

import type {
  DiscountType,
  PaymentMethod,
} from "@/lib/types";
import { enqueue } from "./outbox";
import { decrementSnapshotStock } from "./snapshot";

// Offline-aware variant of `lib/api/sales.ts:recordCartSale`. The cashier
// never has to think about online/offline:
//
//   1. We generate an idempotency key + invoice id client-side so the
//      receipt the customer walks out with is final.
//   2. If we're online, POST normally. The Idempotency-Key header makes a
//      retried request safe (server short-circuits to the cached result).
//   3. If the POST throws (network down, server unreachable, etc.) OR
//      returns 5xx, we queue the row in IndexedDB and return an
//      optimistic result. The sync engine flushes when connectivity
//      comes back.
//   4. 4xx responses are real validation errors — we throw so the form
//      shows the message ("stock too low", "invalid date", etc.).

export interface OfflineCartLine {
  productId: string;
  quantity: number;
  pricePerUnit: number;
  lineDiscountType?: DiscountType;
  lineDiscountValue?: number;
}

export interface OfflineCartOptions {
  note?: string;
  orderDiscountType?: DiscountType;
  orderDiscountValue?: number;
  customDate?: Date;
  customerName?: string;
  customerPhone?: string;
  paymentMethod?: PaymentMethod;
  /** Loyalty redemption — server validates and refuses if balance is short
   *  or the programme is disabled. Offline-queued sales with redemption
   *  are best-effort: if the wallet drops between queue and sync, the row
   *  goes to `failed` and the cashier is notified. */
  redeemPoints?: number;
  applyCreditEgp?: number;
  /** Partial payment on آجل: amount paid at the counter. Distributed across
   *  the line items by the server. Ignored for non-deferred sales. */
  amountPaidNow?: number;
}

export interface OfflineCartContext {
  tenantId: string;
  branchId: string;
}

export interface OfflineCartResult {
  invoiceId: string;
  saleIds: string[];
  /** True when the sale landed on the server immediately. False when it's
   *  sitting in the outbox waiting to sync. The UI uses this to surface
   *  a small "queued" indicator on the receipt. */
  synced: boolean;
}

/** RFC 4122 v4 — modern browsers all expose this. */
function newUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for the rare browser without crypto.randomUUID — random hex.
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}

function makeOfflineInvoiceId(): string {
  // Short URL-safe id derived from time + 6 random bytes. Prefixed `INV-`
  // so receipts look the same as server-generated ones.
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `INV-${ts}${rnd}`.toUpperCase();
}

/** Submit a cart sale with offline fallback. */
export async function recordCartSaleOfflineAware(
  ctx: OfflineCartContext,
  lines: OfflineCartLine[],
  options: OfflineCartOptions = {},
): Promise<OfflineCartResult> {
  const idempotencyKey = newUuid();
  const invoiceId = makeOfflineInvoiceId();

  const payload = {
    lines,
    options: {
      ...options,
      customDate: options.customDate?.toISOString(),
      invoiceId,
    },
  };

  // Attempt the live POST first whenever the browser thinks we're online.
  // navigator.onLine is occasionally optimistic (returns true when no
  // route to internet exists), so we still need the catch path below.
  if (typeof navigator !== "undefined" && navigator.onLine) {
    try {
      const res = await fetch("/api/sales/cart", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "X-Outbox-Branch": ctx.branchId,
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const body = (await res.json()) as {
          invoiceId: string;
          saleIds: string[];
        };
        return {
          invoiceId: body.invoiceId,
          saleIds: body.saleIds,
          synced: true,
        };
      }

      // 4xx → real validation error from the server. Surface it instead
      // of queuing — queuing would just re-fail every retry forever.
      if (res.status >= 400 && res.status < 500) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `HTTP ${res.status}`,
        );
      }
      // 5xx → fall through to the outbox path.
    } catch (err) {
      // TypeError from fetch = network failure. Anything else (4xx
      // thrown above, JSON parse) we re-throw to surface to the form.
      if (
        err instanceof TypeError ||
        (err instanceof Error && /network|fetch/i.test(err.message))
      ) {
        // Fall through to outbox.
      } else {
        throw err;
      }
    }
  }

  // Outbox path: queue + optimistic decrement so the next cart line
  // reflects the lower on-hand count.
  await enqueue({
    type: "sale",
    idempotencyKey,
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    payload,
  });
  for (const l of lines) {
    await decrementSnapshotStock(ctx.tenantId, ctx.branchId, l.productId, l.quantity);
  }
  return { invoiceId, saleIds: [], synced: false };
}
