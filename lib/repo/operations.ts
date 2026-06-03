import { and, eq, desc, sql, inArray } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  products,
  productAttributeValues,
  categoryAttributes,
  productHistory,
  sales,
  returns as returnsTable,
  expenses as expensesTable,
  shopSettings,
} from "@/lib/db/schema";
import type {
  Sale,
  Return,
  Expense,
  DiscountType,
  PaymentMethod,
  ExpenseCategory,
} from "@/lib/types";
import { calcLineDiscount, calcOrderDiscount } from "@/lib/repo/sale-discounts";
import { bustInsightsCache } from "@/lib/repo/insights";
import {
  applyCredit as walletApplyCredit,
  earnPoints as walletEarnPoints,
  redeemPoints as walletRedeemPoints,
} from "@/lib/repo/loyalty";

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

function rowToExpense(r: typeof expensesTable.$inferSelect): Expense {
  return {
    id: r.id,
    title: r.title,
    amount: Number(r.amount),
    category: r.category as ExpenseCategory,
    supplierId: r.supplierId ?? null,
    isRecurring: r.isRecurring,
    recurrencePeriod:
      (r.recurrencePeriod as "monthly" | "weekly" | null) ?? null,
    nextOccurrenceDate: r.nextOccurrenceDate ?? null,
    parentExpenseId: r.parentExpenseId ?? null,
    date: r.date,
    note: r.note ?? undefined,
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
    if (!product) throw new Error("المنتج غير موجود");

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
        isPaid: paymentMethod !== "deferred",
        paidAt: paymentMethod !== "deferred" ? new Date() : null,
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
  /** Loyalty redemption from the customer's wallet. Both default to 0. The
   *  cart endpoint refuses if customerPhone is missing or balance is short.
   *  Each is applied to the cart total as a discount; the redemption value
   *  in EGP is `redeemPoints * loyaltyEgpPerPoint + applyCreditEgp`. */
  redeemPoints?: number;
  applyCreditEgp?: number;
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
  if (lines.length === 0) throw new Error("الفاتورة فارغة");
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

    const pre: Pre[] = [];
    let cartGross = 0;

    for (const line of lines) {
      const [p] = await tx
        .select()
        .from(products)
        .where(and(eq(products.tenantId, tenantId), eq(products.id, line.productId)))
        .limit(1);
      if (!p) throw new Error(`المنتج غير موجود (${line.productId})`);

      // Multi-store: each product belongs to exactly one branch. Refuse a
      // cart line that mixes branches with the active sale context — that
      // would silently move inventory across stores.
      if (p.branchId !== options.branchId) {
        throw new Error(
          `المنتج "${p.name}" لا ينتمي لهذا الفرع — لا يمكن بيعه من هنا`,
        );
      }

      if (p.quantity < line.quantity) {
        throw new Error(
          `الكمية المطلوبة من "${p.name}" غير متوفرة (المتاح ${p.quantity})`,
        );
      }

      const lineSubtotal = line.quantity * line.pricePerUnit;
      const lineDiscount = calcLineDiscount(
        lineSubtotal,
        line.lineDiscountType,
        line.lineDiscountValue,
      );
      cartGross += lineSubtotal - lineDiscount;

      const attrs = await loadAttributeSnapshot(tx, tenantId, line.productId);
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
        throw new Error("لا يمكن خصم نقاط أو رصيد بدون رقم العميل");
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
        throw new Error("برنامج الولاء غير مفعل لهذا الفرع");
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

    const saleIds: string[] = [];
    const lineSummaries: CartSaleLineSummary[] = [];
    let cartTotal = 0;
    let allocated = 0;

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
          isPaid: paymentMethod !== "deferred",
          paidAt: paymentMethod !== "deferred" ? new Date() : null,
          recordedByUserId: options.recordedByUserId ?? null,
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
    await tx
      .update(sales)
      .set({ isPaid: true, paidAt: new Date() })
      .where(and(eq(sales.tenantId, tenantId), eq(sales.id, saleId)));
  });
}

export async function markInvoicePaid(
  tenantId: string,
  invoiceId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(sales)
      .set({ isPaid: true, paidAt: new Date() })
      .where(and(eq(sales.tenantId, tenantId), eq(sales.invoiceId, invoiceId)));
  });
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
// Expenses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spawn child instances for any recurring expense template whose
 * next_occurrence_date has passed, then bump the template's next date forward.
 *
 * Two callers today:
 *   1. `listExpenses` — lazy catch-up when an owner opens /expenses.
 *   2. `/api/cron/recurring-expenses` — periodic sweep so the bill appears
 *      even if no one has visited the page that month.
 *
 * Idempotent: each iteration advances `next_occurrence_date`, so a re-run
 * within the same minute spawns nothing extra.
 */
export async function materializeDueRecurringExpenses(
  tenantId: string,
): Promise<{ spawned: number }> {
  let spawned = 0;
  await withTenant(tenantId, async (tx) => {
    const due = await tx
      .select()
      .from(expensesTable)
      .where(
        and(
          eq(expensesTable.tenantId, tenantId),
          eq(expensesTable.isRecurring, true),
          // next_occurrence_date IS NOT NULL AND <= now()
          sql`${expensesTable.nextOccurrenceDate} is not null`,
          sql`${expensesTable.nextOccurrenceDate} <= now()`,
        ),
      );

    for (const tpl of due) {
      let occurrence = tpl.nextOccurrenceDate ?? new Date();
      // Catch up: spawn one child per missed period until we're back in the future.
      // Cap at 12 iterations defensively in case the template was dormant a long time.
      for (let i = 0; i < 12 && occurrence <= new Date(); i += 1) {
        await tx.insert(expensesTable).values({
          tenantId,
          title: tpl.title,
          amount: tpl.amount,
          category: tpl.category,
          supplierId: tpl.supplierId,
          date: occurrence,
          note: tpl.note,
          parentExpenseId: tpl.id,
          // Children themselves are not recurring.
          isRecurring: false,
        });
        spawned += 1;

        // Optional: debit supplier balance for the child too.
        if (tpl.supplierId) {
          await tx.execute(sql`
            update suppliers
            set balance = (balance)::numeric - ${tpl.amount}::numeric,
                updated_at = now()
            where tenant_id = ${tenantId} and id = ${tpl.supplierId}
          `);
        }

        // Advance.
        const next = new Date(occurrence);
        if (tpl.recurrencePeriod === "weekly") {
          next.setDate(next.getDate() + 7);
        } else {
          // default monthly
          next.setMonth(next.getMonth() + 1);
        }
        occurrence = next;
      }

      await tx
        .update(expensesTable)
        .set({ nextOccurrenceDate: occurrence })
        .where(
          and(
            eq(expensesTable.tenantId, tenantId),
            eq(expensesTable.id, tpl.id),
          ),
        );
    }
  });
  if (spawned > 0) await bustInsightsCache(tenantId);
  return { spawned };
}

export async function listExpenses(
  tenantId: string,
  /** When set, restrict to that branch (excludes tenant-wide null-branch
   *  expenses). Null = every branch + tenant-wide. */
  branchId?: string | null,
): Promise<Expense[]> {
  // Lazy: catch up any due recurring instances before listing.
  await materializeDueRecurringExpenses(tenantId);

  return withTenant(tenantId, async (tx) => {
    const filters = [eq(expensesTable.tenantId, tenantId)];
    if (branchId) filters.push(eq(expensesTable.branchId, branchId));
    const rows = await tx
      .select()
      .from(expensesTable)
      .where(and(...filters))
      .orderBy(desc(expensesTable.date));
    return rows.map(rowToExpense);
  });
}

export interface AddExpenseInput {
  title: string;
  amount: number;
  category: ExpenseCategory;
  supplierId?: string | null;
  isRecurring?: boolean;
  recurrencePeriod?: "monthly" | "weekly" | null;
  date?: Date;
  note?: string;
  /** Branch this expense was incurred at. Null = tenant-wide (e.g. SaaS
   *  subscription, accounting fees) — caller is responsible for the
   *  semantic. */
  branchId?: string | null;
}

export async function addExpense(
  tenantId: string,
  input: AddExpenseInput,
): Promise<{ id: string }> {
  const result = await withTenant(tenantId, async (tx) => {
    const startDate = input.date ?? new Date();
    // For a recurring template, the first occurrence is "now" (recorded as the
    // parent), and the next_occurrence_date is one period after.
    let nextOccurrenceDate: Date | null = null;
    if (input.isRecurring && input.recurrencePeriod) {
      nextOccurrenceDate = new Date(startDate);
      if (input.recurrencePeriod === "weekly") {
        nextOccurrenceDate.setDate(nextOccurrenceDate.getDate() + 7);
      } else {
        nextOccurrenceDate.setMonth(nextOccurrenceDate.getMonth() + 1);
      }
    }

    const [created] = await tx
      .insert(expensesTable)
      .values({
        tenantId,
        branchId: input.branchId ?? null,
        title: input.title,
        amount: String(input.amount),
        category: input.category,
        supplierId: input.supplierId ?? null,
        isRecurring: !!input.isRecurring,
        recurrencePeriod: input.isRecurring
          ? input.recurrencePeriod ?? "monthly"
          : null,
        nextOccurrenceDate,
        date: startDate,
        note: input.note ?? null,
      })
      .returning({ id: expensesTable.id });

    // When this expense is a payment to a supplier, debit their running balance.
    if (input.supplierId) {
      await tx.execute(sql`
        update suppliers
        set balance = (balance)::numeric - ${input.amount.toFixed(2)}::numeric,
            updated_at = now()
        where tenant_id = ${tenantId} and id = ${input.supplierId}
      `);
    }
    return { id: created.id };
  });
  await bustInsightsCache(tenantId);
  return result;
}

export async function deleteExpense(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    // Reverse any supplier balance change first so the running total stays correct.
    const [existing] = await tx
      .select({
        amount: expensesTable.amount,
        supplierId: expensesTable.supplierId,
      })
      .from(expensesTable)
      .where(and(eq(expensesTable.tenantId, tenantId), eq(expensesTable.id, id)))
      .limit(1);

    if (existing?.supplierId) {
      await tx.execute(sql`
        update suppliers
        set balance = (balance)::numeric + ${existing.amount}::numeric,
            updated_at = now()
        where tenant_id = ${tenantId} and id = ${existing.supplierId}
      `);
    }

    await tx
      .delete(expensesTable)
      .where(and(eq(expensesTable.tenantId, tenantId), eq(expensesTable.id, id)));
  });
  await bustInsightsCache(tenantId);
}

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
