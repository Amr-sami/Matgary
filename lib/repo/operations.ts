import { and, eq, desc, sql, inArray } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  products,
  productAttributeValues,
  categoryAttributes,
  productHistory,
  sales,
  returns as returnsTable,
  shopSettings,
  cashShifts,
  cashMovements,
  salePayments,
} from "@/lib/db/schema";
import type {
  Sale,
  Return,
  DiscountType,
  PaymentMethod,
} from "@/lib/types";
import { calcLineDiscount, calcOrderDiscount } from "@/lib/repo/sale-discounts";
import { bustInsightsCache } from "@/lib/repo/insights";
import { DomainError } from "@/lib/errors";
import {
  applyCredit as walletApplyCredit,
  earnPoints as walletEarnPoints,
  redeemPoints as walletRedeemPoints,
} from "@/lib/repo/loyalty";
import {
  NoOpenShiftError,
  resolveShiftStampForSale,
} from "@/lib/repo/cash-shifts";

export { NoOpenShiftError };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeInvoiceId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `INV-${ts}${rnd}`.toUpperCase();
}

function num(v: string | null): number | undefined {
  return v == null ? undefined : Number(v);
}

function rowToSale(r: typeof sales.$inferSelect): Sale {
  const subtotalN = Number(r.subtotal);
  const totalN = Number(r.totalPrice);
  const attrs = (r.attributesSnapshot ?? {}) as Record<string, string>;
  return {
    id: r.id,
    invoiceId: r.invoiceId ?? undefined,
    productId: r.productId,
    productName: r.productName,
    category: r.categoryId,
    gender: attrs.gender ?? "",
    brand: r.brand ?? undefined,
    quantitySold: r.quantitySold,
    pricePerUnit: Number(r.pricePerUnit),
    costPriceAtSale: num(r.costPriceAtSale),
    subtotal: subtotalN,
    discountType: (r.discountType as DiscountType | null) ?? undefined,
    discountValue: num(r.discountValue),
    discountAmount: num(r.discountAmount),
    totalPrice: totalN,
    saleDate: r.saleDate,
    isReturned: r.isReturned,
    returnedAt: r.returnedAt ?? undefined,
    returnedQuantity: r.returnedQuantity ?? undefined,
    note: r.note ?? undefined,
    customerName: r.customerName ?? undefined,
    customerPhone: r.customerPhone ?? undefined,
    paymentMethod: (r.paymentMethod as PaymentMethod | null) ?? undefined,
    isPaid: r.isPaid,
    paidAt: r.paidAt ?? undefined,
    amountPaid: Number(r.amountPaid ?? 0),
    partialPaidAt: r.partialPaidAt ?? undefined,
  };
}

function rowToReturn(r: typeof returnsTable.$inferSelect): Return {
  return {
    id: r.id,
    saleId: r.saleId,
    productId: r.productId,
    productName: r.productName,
    returnedQuantity: r.returnedQuantity,
    returnDate: r.returnDate,
    reason: r.reason ?? "",
  };
}

/**
 * Compute the partial-payment field set for a sale insert.
 *
 * Non-deferred (cash / instapay / card) sales are always fully paid in one
 * shot — amount_paid equals total_price. Deferred sales start at whatever
 * the customer handed over at the counter; if that fully covers the line
 * we treat it as paid. The flags isPaid / paidAt / partialPaidAt are kept
 * consistent so old code that filters on `is_paid` keeps working.
 */
function computePaidFields(
  method: PaymentMethod | "cash",
  totalPrice: number,
  amountPaidNow?: number,
): {
  amountPaid: string;
  isPaid: boolean;
  paidAt: Date | null;
  partialPaidAt: Date | null;
} {
  const now = new Date();
  if (method !== "deferred") {
    return {
      amountPaid: String(totalPrice),
      isPaid: true,
      paidAt: now,
      partialPaidAt: null,
    };
  }
  const paid = Math.max(
    0,
    Math.min(Number(amountPaidNow ?? 0), totalPrice),
  );
  const isFullyPaid = paid >= totalPrice && totalPrice > 0;
  return {
    amountPaid: String(paid),
    isPaid: isFullyPaid,
    paidAt: isFullyPaid ? now : null,
    partialPaidAt: paid > 0 && !isFullyPaid ? now : null,
  };
}

/**
 * Decrement / increment a product's on-hand quantity atomically. `delta` is
 * signed. Returns the new quantity so callers can drop it into product_history.
 *
 * Multi-store: each product belongs to one branch and carries its own qty,
 * so this function no longer takes a branchId — the product row IS the
 * branch context.
 */
async function adjustProductStock(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  productId: string,
  delta: number,
  opts: { allowNegative?: boolean } = {},
): Promise<number> {
  const [row] = await tx
    .select({ quantity: products.quantity, branchId: products.branchId })
    .from(products)
    .where(
      and(eq(products.tenantId, tenantId), eq(products.id, productId)),
    )
    .limit(1);
  if (!row) {
    throw new Error("المنتج غير موجود");
  }
  const next = row.quantity + delta;
  if (next < 0 && !opts.allowNegative) {
    throw new Error("الكمية المطلوبة غير متوفرة في هذا الفرع");
  }
  await tx
    .update(products)
    .set({ quantity: next, updatedAt: new Date() })
    .where(
      and(eq(products.tenantId, tenantId), eq(products.id, productId)),
    );
  return next;
}

/**
 * Snapshot a product's attribute labels at sale time so the receipt + history
 * stay accurate even if the tenant later renames an attribute value.
 */
async function loadAttributeSnapshot(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  productId: string,
): Promise<Record<string, string>> {
  const rows = await tx
    .select({
      key: categoryAttributes.key,
      label: productAttributeValues.valueLabel,
    })
    .from(productAttributeValues)
    .innerJoin(
      categoryAttributes,
      eq(categoryAttributes.id, productAttributeValues.attributeId),
    )
    .where(
      and(
        eq(productAttributeValues.tenantId, tenantId),
        eq(productAttributeValues.productId, productId),
      ),
    );
  const snap: Record<string, string> = {};
  for (const r of rows) snap[r.key] = r.label;
  return snap;
}

/**
 * Bulk version of loadAttributeSnapshot. One query for an array of product
 * ids, returning a Map keyed by product id. Used by recordCartSale to avoid
 * N queries inside the cart pre-loop.
 */
async function loadAttributeSnapshotsBulk(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  productIds: string[],
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (productIds.length === 0) return out;
  const rows = await tx
    .select({
      productId: productAttributeValues.productId,
      key: categoryAttributes.key,
      label: productAttributeValues.valueLabel,
    })
    .from(productAttributeValues)
    .innerJoin(
      categoryAttributes,
      eq(categoryAttributes.id, productAttributeValues.attributeId),
    )
    .where(
      and(
        eq(productAttributeValues.tenantId, tenantId),
        inArray(productAttributeValues.productId, productIds),
      ),
    );
  for (const r of rows) {
    let snap = out.get(r.productId);
    if (!snap) {
      snap = {};
      out.set(r.productId, snap);
    }
    snap[r.key] = r.label;
  }
  // Ensure every requested product has an entry, even if empty — callers can
  // then read without a presence check.
  for (const pid of productIds) {
    if (!out.has(pid)) out.set(pid, {});
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sales — read paths
// ─────────────────────────────────────────────────────────────────────────────

export async function listSales(
  tenantId: string,
  /** When set, restrict to that branch. Null = no filter (every branch). */
  branchId?: string | null,
): Promise<Sale[]> {
  return withTenant(tenantId, async (tx) => {
    const filters = [eq(sales.tenantId, tenantId)];
    if (branchId) filters.push(eq(sales.branchId, branchId));
    const rows = await tx
      .select()
      .from(sales)
      .where(and(...filters))
      .orderBy(desc(sales.saleDate));
    return rows.map(rowToSale);
  });
}

// Cursor-paginated read. The legacy `listSales` returns every row for the
// branch and is fine for small tenants; at 10K invoices the offset/full
// scan starts to bite. Callers that want predictable latency at scale
// should use this variant.
//
// Cursor format: `<saleDate ISO>:<saleId>` — saleDate is the primary
// sort key, saleId breaks ties so the cursor is unambiguous even when
// two sales land in the same millisecond.

export interface ListSalesPageInput {
  /** When set, restrict to that branch. */
  branchId?: string | null;
  /** Page size. Defaults to 50; capped at 200 by the route. */
  limit?: number;
  /** Opaque cursor from a previous page. Null/missing = first page. */
  cursor?: string | null;
}

export interface ListSalesPageResult {
  data: Sale[];
  /** Pass back as `cursor` to fetch the next page. Null = last page. */
  nextCursor: string | null;
}

function encodeSaleCursor(row: { saleDate: Date; id: string }): string {
  return `${row.saleDate.toISOString()}:${row.id}`;
}

function decodeSaleCursor(
  raw: string | null | undefined,
): { saleDate: Date; id: string } | null {
  if (!raw) return null;
  const i = raw.indexOf(":");
  if (i < 0) return null;
  const iso = raw.slice(0, i);
  const id = raw.slice(i + 1);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || !id) return null;
  return { saleDate: d, id };
}

export async function listSalesPage(
  tenantId: string,
  input: ListSalesPageInput = {},
): Promise<ListSalesPageResult> {
  const limit = Math.max(1, Math.min(200, input.limit ?? 50));
  const cursor = decodeSaleCursor(input.cursor ?? null);
  return withTenant(tenantId, async (tx) => {
    // Pull `limit + 1` so we can determine if there's a next page without
    // a separate count query.
    const filters = [eq(sales.tenantId, tenantId)];
    if (input.branchId) filters.push(eq(sales.branchId, input.branchId));
    if (cursor) {
      // (saleDate, id) < (cursor.saleDate, cursor.id) — strict tuple compare
      // so a sale with the SAME date as the cursor row but later id is also
      // skipped (it was on the previous page).
      filters.push(
        sql`(${sales.saleDate}, ${sales.id}) < (${cursor.saleDate.toISOString()}::timestamptz, ${cursor.id})`,
      );
    }
    const rows = await tx
      .select()
      .from(sales)
      .where(and(...filters))
      .orderBy(desc(sales.saleDate), desc(sales.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? encodeSaleCursor(page[page.length - 1]!)
      : null;
    return { data: page.map(rowToSale), nextCursor };
  });
}

export async function getSaleById(
  tenantId: string,
  saleId: string,
): Promise<Sale | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(sales)
      .where(and(eq(sales.tenantId, tenantId), eq(sales.id, saleId)))
      .limit(1);
    return row ? rowToSale(row) : null;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sales — single-line record
// ─────────────────────────────────────────────────────────────────────────────

export interface RecordSaleInput {
  productId: string;
  quantitySold: number;
  pricePerUnit: number;
  note?: string;
  discountType?: DiscountType;
  discountValue?: number;
  customDate?: Date;
  invoiceId?: string;
  customerName?: string;
  customerPhone?: string;
  paymentMethod?: PaymentMethod;
  /** Optional amount the customer paid at the counter for a deferred sale.
   *  Ignored for non-deferred methods (they're always fully paid). Defaults
   *  to 0 when missing — i.e. full receipt deferred. */
  amountPaidNow?: number;
  /** The cashier/owner who recorded this sale. Powers staff performance reports. */
  recordedByUserId?: string;
  /** Branch the sale was rung up at. Required by the multi-branch rollout —
   *  callers must pass the active branch from `requireTenantWithBranch()`.
   *  Inventory is decremented from this branch only. */
  branchId: string;
}

export async function recordSale(
  tenantId: string,
  input: RecordSaleInput,
): Promise<{ saleId: string }> {
  const result = await withTenant(tenantId, async (tx) => {
    const [product] = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, input.productId)))
      .limit(1);
    if (!product) {
      throw new DomainError("PRODUCT_NOT_FOUND", 400, {
        productId: input.productId,
      });
    }

    const subtotal = input.quantitySold * input.pricePerUnit;
    const discountAmount = calcLineDiscount(
      subtotal,
      input.discountType,
      input.discountValue,
    );
    const totalPrice = subtotal - discountAmount;

    // Multi-store inventory: products carry their own per-branch qty. The
    // route already verified the product belongs to the active branch
    // (listProducts filters by branchId before the picker shows it), so we
    // just decrement.
    const nextBranchQty = await adjustProductStock(
      tx,
      tenantId,
      input.productId,
      -input.quantitySold,
    );

    const attrs = await loadAttributeSnapshot(tx, tenantId, input.productId);
    const paymentMethod: PaymentMethod = input.paymentMethod || "cash";

    const [created] = await tx
      .insert(sales)
      .values({
        tenantId,
        branchId: input.branchId,
        invoiceId: input.invoiceId || makeInvoiceId(),
        productId: input.productId,
        productName: product.name,
        categoryId: product.categoryId,
        attributesSnapshot: attrs,
        brand: product.brand ?? null,
        quantitySold: input.quantitySold,
        pricePerUnit: String(input.pricePerUnit),
        costPriceAtSale: product.costPrice ?? null,
        subtotal: String(subtotal),
        discountType: input.discountType ?? null,
        discountValue:
          input.discountValue != null ? String(input.discountValue) : null,
        discountAmount: discountAmount > 0 ? String(discountAmount) : null,
        totalPrice: String(totalPrice),
        saleDate: input.customDate ?? new Date(),
        note: input.note ?? null,
        customerName: input.customerName?.trim() || null,
        customerPhone: input.customerPhone?.trim() || null,
        paymentMethod,
        // Partial-payments semantics: non-deferred is always fully paid;
        // deferred starts at whatever the customer handed over at the
        // counter (often 0). is_paid mirrors amount_paid >= total.
        ...computePaidFields(paymentMethod, totalPrice, input.amountPaidNow),
        recordedByUserId: input.recordedByUserId ?? null,
      })
      .returning({ id: sales.id });

    await tx.insert(productHistory).values({
      tenantId,
      productId: input.productId,
      productName: product.name,
      type: "sold",
      delta: -input.quantitySold,
      // History reflects the branch-level quantity-after, not the global
      // sum, so the per-branch stock journal stays sensible.
      quantityAfter: nextBranchQty,
    });

    return { saleId: created.id };
  });
  await bustInsightsCache(tenantId);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sales — cart (multi-line, shared invoice, proportional order discount)
// ─────────────────────────────────────────────────────────────────────────────

export interface CartSaleLineInput {
  productId: string;
  quantity: number;
  pricePerUnit: number;
  lineDiscountType?: DiscountType;
  lineDiscountValue?: number;
}

export interface CartSaleOptions {
  note?: string;
  orderDiscountType?: DiscountType;
  orderDiscountValue?: number;
  customDate?: Date;
  customerName?: string;
  customerPhone?: string;
  paymentMethod?: PaymentMethod;
  /** The cashier/owner who recorded this sale. Powers staff performance reports. */
  recordedByUserId?: string;
  /** Branch the sale was rung up at. Required by the multi-branch rollout —
   *  every line decrements inventory at this branch only. */
  branchId: string;
  /** Optional client-supplied invoice id. Used by the offline POS so the
   *  cashier sees the same invoice number on the receipt regardless of
   *  whether the sale synced immediately or hours later. Server picks one
   *  itself when omitted. */
  invoiceId?: string;
  /** Role of the recorder — used to decide if cash sales without an open
   *  shift should auto-open an owner-desk shift (owners) or 409 (cashiers).
   *  Optional; defaults to non-owner. */
  recordedByRole?: "owner" | "staff" | null;
  /** Loyalty redemption from the customer's wallet. Both default to 0. The
   *  cart endpoint refuses if customerPhone is missing or balance is short.
   *  Each is applied to the cart total as a discount; the redemption value
   *  in EGP is `redeemPoints * loyaltyEgpPerPoint + applyCreditEgp`. */
  redeemPoints?: number;
  applyCreditEgp?: number;
  /** For deferred sales: amount the customer paid at the counter. Allocated
   *  proportionally across line items so the per-customer outstanding total
   *  reflects exactly the unpaid remainder. Ignored for non-deferred sales
   *  (those are always fully paid). Defaults to 0. */
  amountPaidNow?: number;
}

export interface CartSaleLineSummary {
  productName: string;
  quantity: number;
  pricePerUnit: number;
  lineTotal: number;
}

export interface CartSaleResult {
  invoiceId: string;
  saleIds: string[];
  /** Per-line readable summary, useful for activity logs / receipts. */
  lines: CartSaleLineSummary[];
  /** Final total (after all discounts), in tenant currency. */
  total: number;
  paymentMethod: PaymentMethod;
  customerName: string | null;
  customerPhone: string | null;
  note: string | null;
}

export async function recordCartSale(
  tenantId: string,
  lines: CartSaleLineInput[],
  options: CartSaleOptions,
): Promise<CartSaleResult> {
  if (lines.length === 0) throw new DomainError("CART_EMPTY", 400);
  // Honour a client-supplied invoice id when valid (offline POS uses this
  // so the receipt the cashier handed the customer matches the eventual
  // server record). Falls back to a fresh server-generated id otherwise.
  const invoiceId =
    options.invoiceId && /^[A-Za-z0-9_\-:.]{4,80}$/.test(options.invoiceId)
      ? options.invoiceId
      : makeInvoiceId();
  const saleDate = options.customDate ?? new Date();
  const paymentMethod: PaymentMethod = options.paymentMethod || "cash";

  const result = await withTenant(tenantId, async (tx) => {
    type Pre = {
      line: CartSaleLineInput;
      product: typeof products.$inferSelect;
      attrs: Record<string, string>;
      lineSubtotal: number;
      lineDiscount: number;
    };

    // Bulk-load every product + every attribute snapshot in two queries
    // instead of two per line. Mixed product IDs collapse via the Map; a
    // duplicate line just hits the same Map entry without an extra read.
    const productIds = Array.from(new Set(lines.map((l) => l.productId)));
    const productRows = await tx
      .select()
      .from(products)
      .where(
        and(eq(products.tenantId, tenantId), inArray(products.id, productIds)),
      );
    const productById = new Map(productRows.map((p) => [p.id, p] as const));
    const attrsByProductId = await loadAttributeSnapshotsBulk(
      tx,
      tenantId,
      productIds,
    );

    // Aggregate the requested quantity per product across all cart lines.
    // We compare TOTAL request vs available stock — splitting a "buy 5"
    // across two cart lines must still respect the 4-in-stock limit.
    const requestedByProductId = new Map<string, number>();
    for (const line of lines) {
      requestedByProductId.set(
        line.productId,
        (requestedByProductId.get(line.productId) ?? 0) + line.quantity,
      );
    }

    const pre: Pre[] = [];
    let cartGross = 0;

    for (const line of lines) {
      const p = productById.get(line.productId);
      if (!p) {
        throw new DomainError("PRODUCT_NOT_FOUND", 400, {
          productId: line.productId,
        });
      }

      // Multi-store: each product belongs to exactly one branch. Refuse a
      // cart line that mixes branches with the active sale context — that
      // would silently move inventory across stores.
      if (p.branchId !== options.branchId) {
        throw new DomainError("PRODUCT_WRONG_BRANCH", 400, {
          productId: p.id,
          productName: p.name,
        });
      }

      const totalRequested = requestedByProductId.get(line.productId) ?? line.quantity;
      if (p.quantity < totalRequested) {
        throw new DomainError("INSUFFICIENT_STOCK", 400, {
          productId: p.id,
          productName: p.name,
          requested: totalRequested,
          available: p.quantity,
        });
      }

      const lineSubtotal = line.quantity * line.pricePerUnit;
      const lineDiscount = calcLineDiscount(
        lineSubtotal,
        line.lineDiscountType,
        line.lineDiscountValue,
      );
      cartGross += lineSubtotal - lineDiscount;

      const attrs = attrsByProductId.get(line.productId) ?? {};
      pre.push({ line, product: p, attrs, lineSubtotal, lineDiscount });
    }

    // Order-level discount needs to remain mutable — the loyalty step below
    // layers redeemed points + applied credit on top before the per-line
    // proportional allocation runs.
    let orderDiscountTotal = calcOrderDiscount(
      cartGross,
      options.orderDiscountType,
      options.orderDiscountValue,
    );

    // ── Loyalty redemption pre-check ───────────────────────────────────
    // We resolve points + credit redemption BEFORE the per-line allocation
    // loop so the customer-facing total reflects the discount. Wallet
    // balances are mutated AFTER the sale rows are inserted (so the
    // events can carry the saleIds for traceability).
    const customerPhoneNorm = options.customerPhone?.trim() || null;
    const requestedPoints = Math.max(
      0,
      Math.floor(Number(options.redeemPoints ?? 0)),
    );
    const requestedCredit = Math.max(0, Number(options.applyCreditEgp ?? 0));
    let pointsToRedeem = 0;
    let creditToApplyEgp = 0;
    let loyaltyDiscountEgp = 0;
    if (requestedPoints > 0 || requestedCredit > 0) {
      if (!customerPhoneNorm) {
        throw new DomainError("LOYALTY_REQUIRES_CUSTOMER_PHONE", 400);
      }
      // Read the active branch's loyalty config + the customer's wallet
      // in the same tx so we don't race a concurrent grant/redeem.
      const [setting] = await tx
        .select({
          enabled: shopSettings.loyaltyEnabled,
          egpPerPoint: shopSettings.loyaltyEgpPerPoint,
        })
        .from(shopSettings)
        .where(
          and(
            eq(shopSettings.tenantId, tenantId),
            eq(shopSettings.branchId, options.branchId),
          ),
        )
        .limit(1);
      if (!setting?.enabled) {
        throw new DomainError("LOYALTY_DISABLED_FOR_BRANCH", 400);
      }
      const egpPerPoint = Number(setting.egpPerPoint ?? 0);
      pointsToRedeem = requestedPoints;
      creditToApplyEgp = requestedCredit;
      loyaltyDiscountEgp =
        Math.round(pointsToRedeem * egpPerPoint * 100) / 100 +
        creditToApplyEgp;
      // Cap the loyalty discount to whatever's left after order-level
      // discount — we never want negative-total invoices.
      const remaining = cartGross - orderDiscountTotal;
      if (loyaltyDiscountEgp > remaining) {
        loyaltyDiscountEgp = remaining;
        // Re-derive the redemption amounts so the wallet only burns what
        // actually got used. Prefer to keep credit (more flexible) and
        // trim points first.
        const wantedFromPoints = pointsToRedeem * egpPerPoint;
        if (creditToApplyEgp >= remaining) {
          creditToApplyEgp = remaining;
          pointsToRedeem = 0;
        } else {
          const fromPoints = remaining - creditToApplyEgp;
          pointsToRedeem =
            egpPerPoint > 0 ? Math.floor(fromPoints / egpPerPoint) : 0;
        }
        // Recompute exact discount using the trimmed values.
        loyaltyDiscountEgp =
          Math.round(pointsToRedeem * egpPerPoint * 100) / 100 +
          creditToApplyEgp;
      }
      // Treat loyalty as another order-level discount layer for the
      // proportional per-line allocation. Receipts show a combined
      // "discount" line; the wallet events table is the structured trail.
      orderDiscountTotal = Math.min(
        cartGross,
        orderDiscountTotal + loyaltyDiscountEgp,
      );
    }

    // Cash-drawer reconciliation: resolve the shift this cart should be
    // stamped onto (or null if reconciliation is off / non-cash). Throws
    // NoOpenShiftError when a cashier tries to ring up cash without an
    // open shift — the route turns that into 409 NO_OPEN_SHIFT and the
    // client prompts to open one.
    const cashShiftId = await resolveShiftStampForSale(tx, {
      tenantId,
      branchId: options.branchId,
      recordedByUserId: options.recordedByUserId ?? null,
      isOwner: options.recordedByRole === "owner",
      paymentMethod,
    });

    const saleIds: string[] = [];
    const lineSummaries: CartSaleLineSummary[] = [];
    let cartTotal = 0;
    let allocated = 0;

    // Partial payments: distribute the cashier-entered "amount paid now"
    // proportionally across the lines so per-customer outstanding math is
    // a plain sum across rows. Non-deferred = always fully paid (every
    // line's amount_paid = its totalPrice).
    const cartFinalTotal = Math.max(0, cartGross - orderDiscountTotal);
    const requestedPaidNow =
      paymentMethod === "deferred"
        ? Math.max(0, Math.min(Number(options.amountPaidNow ?? 0), cartFinalTotal))
        : cartFinalTotal;
    let paidRemaining = requestedPaidNow;

    for (let i = 0; i < pre.length; i++) {
      const p = pre[i];
      const afterLine = p.lineSubtotal - p.lineDiscount;
      const sharePct = cartGross > 0 ? afterLine / cartGross : 0;
      let allocation =
        i === pre.length - 1
          ? orderDiscountTotal - allocated
          : Math.round(orderDiscountTotal * sharePct);
      allocation = Math.max(0, Math.min(allocation, afterLine));
      allocated += allocation;
      const totalLineDiscount = p.lineDiscount + allocation;
      const totalPrice = p.lineSubtotal - totalLineDiscount;

      // Per-line slice of the customer's down payment. Proportional to the
      // line's share of the cart final total; the last line picks up the
      // rounding remainder so the sum exactly equals requestedPaidNow. We
      // ALWAYS clamp to `totalPrice` (including the last line) — the new
      // CHECK constraint `amount_paid <= total_price` would otherwise
      // reject the insert if rounding pushed the remainder a cent above
      // the last line's total. The dropped cents (rare; bounded by
      // pre.length × 0.01 EGP) are an accepted rounding artifact.
      const isLastLine = i === pre.length - 1;
      const linePaid = Math.min(
        totalPrice,
        isLastLine
          ? paidRemaining
          : cartFinalTotal > 0
            ? Math.round(
                ((requestedPaidNow * totalPrice) / cartFinalTotal) * 100,
              ) / 100
            : 0,
      );
      paidRemaining = Math.max(0, paidRemaining - linePaid);

      // Decrement the product's qty directly (multi-store: the product
      // already belongs to options.branchId, verified in the pre-loop).
      const nextBranchQty = await adjustProductStock(
        tx,
        tenantId,
        p.line.productId,
        -p.line.quantity,
      );

      const [created] = await tx
        .insert(sales)
        .values({
          tenantId,
          branchId: options.branchId,
          invoiceId,
          productId: p.line.productId,
          productName: p.product.name,
          categoryId: p.product.categoryId,
          attributesSnapshot: p.attrs,
          brand: p.product.brand ?? null,
          quantitySold: p.line.quantity,
          pricePerUnit: String(p.line.pricePerUnit),
          costPriceAtSale: p.product.costPrice ?? null,
          subtotal: String(p.lineSubtotal),
          discountType:
            totalLineDiscount > 0
              ? p.line.lineDiscountType ??
                (options.orderDiscountType === "percentage"
                  ? "percentage"
                  : "fixed")
              : null,
          discountValue:
            totalLineDiscount > 0 && p.line.lineDiscountValue
              ? String(p.line.lineDiscountValue)
              : null,
          discountAmount: totalLineDiscount > 0 ? String(totalLineDiscount) : null,
          totalPrice: String(totalPrice),
          saleDate,
          note: options.note ?? null,
          customerName: options.customerName?.trim() || null,
          customerPhone: options.customerPhone?.trim() || null,
          paymentMethod,
          ...computePaidFields(paymentMethod, totalPrice, linePaid),
          recordedByUserId: options.recordedByUserId ?? null,
          cashShiftId,
        })
        .returning({ id: sales.id });

      saleIds.push(created.id);
      lineSummaries.push({
        productName: p.product.name,
        quantity: p.line.quantity,
        pricePerUnit: p.line.pricePerUnit,
        lineTotal: totalPrice,
      });
      cartTotal += totalPrice;

      await tx.insert(productHistory).values({
        tenantId,
        productId: p.line.productId,
        productName: p.product.name,
        type: "sold",
        delta: -p.line.quantity,
        quantityAfter: nextBranchQty,
      });
    }

    // ── Loyalty post-pass ─────────────────────────────────────────────
    // 1. Burn the redeemed points / credit (events tagged with the first
    //    sale id from this invoice for traceability).
    // 2. Award points on the FINAL paid amount (after every discount,
    //    including the loyalty discount itself — points never compound).
    if (customerPhoneNorm && (pointsToRedeem > 0 || creditToApplyEgp > 0)) {
      const baseCtx = {
        tenantId,
        branchId: options.branchId,
        customerPhone: customerPhoneNorm,
        customerName: options.customerName?.trim() || null,
        actorUserId: options.recordedByUserId ?? null,
        relatedSaleId: saleIds[0] ?? null,
      };
      if (pointsToRedeem > 0) {
        await walletRedeemPoints(tx, baseCtx, pointsToRedeem);
      }
      if (creditToApplyEgp > 0) {
        await walletApplyCredit(tx, baseCtx, creditToApplyEgp);
      }
    }

    if (
      customerPhoneNorm &&
      paymentMethod !== "deferred" &&
      cartTotal > 0
    ) {
      // Read loyalty earn rate. Settings might not exist yet for a brand
      // new branch — silently skip in that case.
      const [setting] = await tx
        .select({
          enabled: shopSettings.loyaltyEnabled,
          pointsPerEgp: shopSettings.loyaltyPointsPerEgp,
        })
        .from(shopSettings)
        .where(
          and(
            eq(shopSettings.tenantId, tenantId),
            eq(shopSettings.branchId, options.branchId),
          ),
        )
        .limit(1);
      if (setting?.enabled) {
        const rate = Number(setting.pointsPerEgp ?? 0);
        const earned = Math.floor(cartTotal * rate);
        if (earned > 0) {
          await walletEarnPoints(
            tx,
            {
              tenantId,
              branchId: options.branchId,
              customerPhone: customerPhoneNorm,
              customerName: options.customerName?.trim() || null,
              actorUserId: options.recordedByUserId ?? null,
              relatedSaleId: saleIds[0] ?? null,
            },
            earned,
          );
        }
      }
    }

    return {
      invoiceId,
      saleIds,
      lines: lineSummaries,
      total: cartTotal,
      paymentMethod,
      customerName: options.customerName?.trim() || null,
      customerPhone: options.customerPhone?.trim() || null,
      note: options.note ?? null,
    };
  });
  await bustInsightsCache(tenantId);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sales — update / void / mark paid
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateSaleInput {
  quantitySold?: number;
  pricePerUnit?: number;
  discountType?: DiscountType | null;
  discountValue?: number | null;
  note?: string | null;
  saleDate?: Date;
}

export async function updateSale(
  tenantId: string,
  saleId: string,
  patch: UpdateSaleInput,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [sale] = await tx
      .select()
      .from(sales)
      .where(and(eq(sales.tenantId, tenantId), eq(sales.id, saleId)))
      .limit(1);
    if (!sale) throw new Error("البيع غير موجود");

    const oldQty = sale.quantitySold;
    const newQty = patch.quantitySold ?? oldQty;
    const newPrice = patch.pricePerUnit ?? Number(sale.pricePerUnit);
    const newDiscType =
      patch.discountType === undefined
        ? (sale.discountType as DiscountType | null)
        : patch.discountType;
    const newDiscVal =
      patch.discountValue === undefined
        ? (sale.discountValue ? Number(sale.discountValue) : null)
        : patch.discountValue;

    const subtotal = newQty * newPrice;
    let discountAmount = 0;
    if (newDiscType && typeof newDiscVal === "number" && newDiscVal > 0) {
      discountAmount =
        newDiscType === "percentage"
          ? Math.round((subtotal * newDiscVal) / 100)
          : newDiscVal;
    }
    discountAmount = Math.min(discountAmount, subtotal);
    const totalPrice = subtotal - discountAmount;

    if (newQty !== oldQty) {
      const [p] = await tx
        .select({ quantity: products.quantity })
        .from(products)
        .where(and(eq(products.tenantId, tenantId), eq(products.id, sale.productId)))
        .limit(1);
      if (p) {
        const stockDelta = oldQty - newQty;
        const nextStock = Math.max(0, p.quantity + stockDelta);
        await tx
          .update(products)
          .set({ quantity: nextStock, updatedAt: new Date() })
          .where(
            and(eq(products.tenantId, tenantId), eq(products.id, sale.productId)),
          );
      }
    }

    const set: Record<string, unknown> = {
      quantitySold: newQty,
      pricePerUnit: String(newPrice),
      subtotal: String(subtotal),
      discountType: newDiscType ?? null,
      discountValue: newDiscVal != null ? String(newDiscVal) : null,
      discountAmount: discountAmount > 0 ? String(discountAmount) : null,
      totalPrice: String(totalPrice),
    };
    if (patch.note !== undefined) set.note = patch.note || null;
    if (patch.saleDate) set.saleDate = patch.saleDate;

    await tx
      .update(sales)
      .set(set)
      .where(and(eq(sales.tenantId, tenantId), eq(sales.id, saleId)));
  });
  await bustInsightsCache(tenantId);
}

export async function voidSale(tenantId: string, saleId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [sale] = await tx
      .select()
      .from(sales)
      .where(and(eq(sales.tenantId, tenantId), eq(sales.id, saleId)))
      .limit(1);
    if (!sale) throw new Error("البيع غير موجود");

    if (!sale.isReturned) {
      // Refund stock — only if the sale wasn't already returned (stock was
      // refunded then). Mirrors firestore.voidSale semantics.
      await tx
        .update(products)
        .set({
          quantity: sql`${products.quantity} + ${sale.quantitySold}`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(products.tenantId, tenantId), eq(products.id, sale.productId)),
        );
    }

    await tx
      .delete(sales)
      .where(and(eq(sales.tenantId, tenantId), eq(sales.id, saleId)));
  });
  await bustInsightsCache(tenantId);
}

export async function markSalePaid(tenantId: string, saleId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    // Bring amount_paid up to total_price so the receivables aggregator
    // agrees with the is_paid flag. Without this, "mark paid" leaves an
    // amount_paid=0 row that the customer page still flags as owed.
    await tx.execute(sql`
      UPDATE sales
         SET is_paid           = true,
             paid_at           = now(),
             amount_paid       = CAST(total_price AS numeric(14,2)),
             partial_paid_at   = NULL
       WHERE tenant_id = ${tenantId}
         AND id        = ${saleId}
    `);
  });
}

export async function markInvoicePaid(
  tenantId: string,
  invoiceId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.execute(sql`
      UPDATE sales
         SET is_paid           = true,
             paid_at           = now(),
             amount_paid       = CAST(total_price AS numeric(14,2)),
             partial_paid_at   = NULL
       WHERE tenant_id  = ${tenantId}
         AND invoice_id = ${invoiceId}
    `);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer settlements — record a later payment against a customer's
// outstanding balance. Applies the amount oldest-first across unpaid sales
// (or restricted to `invoiceIds` when the caller hand-picks invoices).
// Returns a summary the caller can drop into a toast / activity log.
// ─────────────────────────────────────────────────────────────────────────────

export type SettlementMethod = "cash" | "instapay" | "card";

export interface SettleCustomerPaymentInput {
  /** Customer matching key — canonicalised E.164 phone (the same key the
   *  customer aggregator uses). At least one unpaid sale must carry this
   *  phone or the call returns NOTHING_TO_SETTLE. */
  customerPhone: string;
  /** Amount the customer just paid. Must be > 0. */
  amount: number;
  /** How they paid. Cash settlements stamp the active cash shift so the
   *  Z-report sees the receipt the next time the cashier closes out. */
  method: SettlementMethod;
  /** Optional restriction: settle only these invoices. If omitted we apply
   *  the amount across all unpaid invoices oldest-first. */
  invoiceIds?: string[];
  /** Cashier / owner recording the settlement — required for cash-shift
   *  stamping and activity logging. */
  recordedByUserId: string;
  /** Branch context — used to locate the active cash shift for the cash
   *  movement record. */
  branchId: string;
}

export interface SettleCustomerPaymentResult {
  /** Sum actually applied across the unpaid sales. Equals `input.amount`
   *  unless the customer's outstanding balance was lower (we never
   *  over-credit; the leftover is returned in `overpay`). */
  appliedAmount: number;
  /** Amount the caller offered that we couldn't apply because the
   *  customer's balance ran out. UI should surface this back to the
   *  cashier so they know whether to bank it as customer credit or
   *  refund it. */
  overpay: number;
  /** Number of distinct invoices that are now fully settled by this
   *  payment. Drives the "settled X invoices" toast copy. */
  fullySettledInvoices: number;
  /** The customer's remaining outstanding balance AFTER this payment. */
  newBalance: number;
}

export class SettlementError extends Error {
  constructor(
    public code:
      | "INVALID_AMOUNT"
      | "INVALID_METHOD"
      | "NOTHING_TO_SETTLE"
      | "PHONE_REQUIRED",
    public httpStatus: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "SettlementError";
  }
}

export async function settleCustomerPayment(
  tenantId: string,
  input: SettleCustomerPaymentInput,
): Promise<SettleCustomerPaymentResult> {
  if (!input.customerPhone.trim()) {
    throw new SettlementError("PHONE_REQUIRED", 400, "Customer phone required");
  }
  const requested = Number(input.amount);
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new SettlementError("INVALID_AMOUNT", 400, "Amount must be positive");
  }
  if (
    input.method !== "cash" &&
    input.method !== "instapay" &&
    input.method !== "card"
  ) {
    throw new SettlementError("INVALID_METHOD", 400);
  }

  const result = await withTenant(tenantId, async (tx) => {
    // Fetch unpaid sales for this customer oldest-first. We deliberately
    // re-read amount_paid inside the same tx so two cashiers can't double-
    // apply against the same row (FOR UPDATE would be safer; postgres.js
    // doesn't expose it cleanly here so we accept the tiny race).
    const unpaidRows = (await tx.execute(sql`
      SELECT id,
             invoice_id,
             total_price,
             amount_paid,
             sale_date
        FROM sales
       WHERE tenant_id      = ${tenantId}
         AND customer_phone = ${input.customerPhone}
         AND is_returned    = false
         AND is_paid        = false
         ${
           input.invoiceIds && input.invoiceIds.length > 0
             ? sql`AND invoice_id IN (${sql.join(
                 input.invoiceIds.map((id) => sql`${id}`),
                 sql`, `,
               )})`
             : sql``
         }
       ORDER BY sale_date ASC, id ASC
    `)) as unknown as Array<{
      id: string;
      invoice_id: string | null;
      total_price: string;
      amount_paid: string;
      sale_date: Date;
    }>;

    if (unpaidRows.length === 0) {
      throw new SettlementError(
        "NOTHING_TO_SETTLE",
        409,
        "No unpaid sales for this customer",
      );
    }

    let remaining = requested;
    const fullySettledInvoices = new Set<string>();
    const now = new Date();
    // ISO-string form for SQL param binding. Drizzle's raw `sql` template
    // serializes JS Date via Date.prototype.toString() (e.g. "Thu Jun 11
    // 2026 06:10:03 GMT+0300"), which Postgres can't parse as a
    // timestamptz. The ISO form goes through cleanly.
    const nowIso = now.toISOString();

    // Resolve the active cash shift ONCE up front so every sale_payments
    // row we insert can carry it. Cash settlements also drop a single
    // aggregate cash_movements row at the end of the loop (kept that way
    // so the cash drawer shows one line per customer pay-down, not one
    // per invoice — easier to read on the Z-report).
    const [activeShift] = await tx
      .select({ id: cashShifts.id })
      .from(cashShifts)
      .where(
        and(
          eq(cashShifts.tenantId, tenantId),
          eq(cashShifts.branchId, input.branchId),
          eq(cashShifts.cashierUserId, input.recordedByUserId),
          eq(cashShifts.status, "open"),
        ),
      )
      .limit(1);
    const shiftIdForPayments =
      input.method === "cash" && activeShift ? activeShift.id : null;

    for (const row of unpaidRows) {
      if (remaining <= 0) break;
      const lineTotal = Number(row.total_price);
      const lineAlreadyPaid = Number(row.amount_paid);
      const lineOwed = Math.max(0, lineTotal - lineAlreadyPaid);
      if (lineOwed <= 0) continue;
      const apply = Math.min(remaining, lineOwed);
      const newPaid = lineAlreadyPaid + apply;
      const fullyPaid = newPaid >= lineTotal;
      remaining -= apply;
      if (fullyPaid && row.invoice_id) {
        fullySettledInvoices.add(row.invoice_id);
      }
      await tx.execute(sql`
        UPDATE sales
           SET amount_paid     = ${String(newPaid)}::numeric(14,2),
               is_paid         = ${fullyPaid},
               paid_at         = CASE WHEN ${fullyPaid} THEN ${nowIso}::timestamptz ELSE paid_at END,
               partial_paid_at = CASE WHEN ${fullyPaid} THEN NULL ELSE ${nowIso}::timestamptz END
         WHERE tenant_id = ${tenantId}
           AND id        = ${row.id}
      `);
      // Persist the individual event so the customer detail page can
      // render a real timeline (vs. just the latest partial_paid_at).
      await tx.insert(salePayments).values({
        tenantId,
        saleId: row.id,
        amount: String(apply),
        method: input.method,
        recordedAt: now,
        recordedByUserId: input.recordedByUserId,
        cashShiftId: shiftIdForPayments,
      });
    }

    const applied = requested - remaining;
    const overpay = remaining;

    // Cash settlements stamp the active cash shift so the Z-report
    // captures the receipt. We DON'T auto-open a shift here (unlike the
    // sale path) — if no shift is open, the settlement still records but
    // the cashier loses the drawer reconciliation. Reason: customer
    // settlements often happen outside of a normal serving rhythm
    // (owner pops in for a few minutes), and forcing a shift-open here
    // would be more friction than benefit. If you want to flip this,
    // call resolveShiftStampForSale instead.
    if (input.method === "cash" && applied > 0) {
      const shift = activeShift;
      if (shift) {
        await tx.insert(cashMovements).values({
          tenantId,
          shiftId: shift.id,
          kind: "paid_in",
          amount: String(applied),
          reason: `Customer settlement — ${input.customerPhone}`,
          recordedByUserId: input.recordedByUserId,
        });
      }
    }

    // New balance for this customer = sum of remaining unpaid balance.
    const [{ owed }] = (await tx.execute(sql`
      SELECT COALESCE(
               SUM(CAST(total_price AS numeric(14,2)) - amount_paid),
               0
             )::text AS owed
        FROM sales
       WHERE tenant_id      = ${tenantId}
         AND customer_phone = ${input.customerPhone}
         AND is_returned    = false
         AND is_paid        = false
    `)) as unknown as Array<{ owed: string }>;

    return {
      appliedAmount: applied,
      overpay,
      fullySettledInvoices: fullySettledInvoices.size,
      newBalance: Number(owed),
    };
  });

  await bustInsightsCache(tenantId);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Returns
// ─────────────────────────────────────────────────────────────────────────────

export async function listReturns(
  tenantId: string,
  /** When set, restrict to returns whose parent sale was rung up at that
   *  branch. Null = every branch. */
  branchId?: string | null,
): Promise<Return[]> {
  return withTenant(tenantId, async (tx) => {
    if (branchId) {
      // Join sales so we can filter on the parent sale's branch.
      const rows = await tx
        .select({ r: returnsTable })
        .from(returnsTable)
        .innerJoin(sales, eq(sales.id, returnsTable.saleId))
        .where(
          and(
            eq(returnsTable.tenantId, tenantId),
            eq(sales.branchId, branchId),
          ),
        )
        .orderBy(desc(returnsTable.returnDate));
      return rows.map((row) => rowToReturn(row.r));
    }
    const rows = await tx
      .select()
      .from(returnsTable)
      .where(eq(returnsTable.tenantId, tenantId))
      .orderBy(desc(returnsTable.returnDate));
    return rows.map(rowToReturn);
  });
}

export interface RecordReturnInput {
  saleId: string;
  productId: string;
  returnedQuantity: number;
  reason: string;
}

export async function recordReturn(
  tenantId: string,
  input: RecordReturnInput,
): Promise<{ returnId: string }> {
  const result = await withTenant(tenantId, async (tx) => {
    const [sale] = await tx
      .select()
      .from(sales)
      .where(and(eq(sales.tenantId, tenantId), eq(sales.id, input.saleId)))
      .limit(1);
    if (!sale) throw new Error("البيع غير موجود");

    // Re-credit the product's qty directly — multi-store products always
    // live at one branch so there's no ambiguity. allowNegative=true on the
    // off chance the qty went stale via concurrent writes.
    await adjustProductStock(
      tx,
      tenantId,
      input.productId,
      input.returnedQuantity,
      { allowNegative: true },
    );

    await tx
      .update(sales)
      .set({
        isReturned: true,
        returnedAt: new Date(),
        returnedQuantity: input.returnedQuantity,
      })
      .where(and(eq(sales.tenantId, tenantId), eq(sales.id, input.saleId)));

    const [created] = await tx
      .insert(returnsTable)
      .values({
        tenantId,
        saleId: input.saleId,
        productId: input.productId,
        productName: sale.productName,
        returnedQuantity: input.returnedQuantity,
        reason: input.reason || null,
      })
      .returning({ id: returnsTable.id });

    await tx.insert(productHistory).values({
      tenantId,
      productId: input.productId,
      productName: sale.productName,
      type: "returned",
      delta: input.returnedQuantity,
      note: input.reason || null,
    });

    return { returnId: created.id };
  });
  await bustInsightsCache(tenantId);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Expenses — moved to lib/repo/expenses.ts in the Phase 2 god-module split.
// Re-exported here so the existing 50+ call-sites that import from
// "@/lib/repo/operations" keep working. New code should import directly
// from "@/lib/repo/expenses".
// ─────────────────────────────────────────────────────────────────────────────
export {
  materializeDueRecurringExpenses,
  listExpenses,
  addExpense,
  deleteExpense,
} from "@/lib/repo/expenses";
export type { AddExpenseInput } from "@/lib/repo/expenses";

// ─────────────────────────────────────────────────────────────────────────────
// Bulk delete sales (used by sales page)
// ─────────────────────────────────────────────────────────────────────────────

export async function bulkDeleteSales(
  tenantId: string,
  saleIds: string[],
): Promise<void> {
  if (saleIds.length === 0) return;
  await withTenant(tenantId, async (tx) => {
    // Refund stock for non-returned sales before delete.
    const rows = await tx
      .select({
        id: sales.id,
        productId: sales.productId,
        quantitySold: sales.quantitySold,
        isReturned: sales.isReturned,
      })
      .from(sales)
      .where(and(eq(sales.tenantId, tenantId), inArray(sales.id, saleIds)));

    for (const r of rows) {
      if (!r.isReturned) {
        await tx
          .update(products)
          .set({
            quantity: sql`${products.quantity} + ${r.quantitySold}`,
            updatedAt: new Date(),
          })
          .where(
            and(eq(products.tenantId, tenantId), eq(products.id, r.productId)),
          );
      }
    }

    await tx
      .delete(sales)
      .where(and(eq(sales.tenantId, tenantId), inArray(sales.id, saleIds)));
  });
  await bustInsightsCache(tenantId);
}
