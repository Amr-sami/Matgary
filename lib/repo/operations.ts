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
} from "@/lib/db/schema";
import type {
  Sale,
  Return,
  Expense,
  DiscountType,
  PaymentMethod,
  ExpenseCategory,
} from "@/lib/types";

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
    date: r.date,
    note: r.note ?? undefined,
  };
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

export async function listSales(tenantId: string): Promise<Sale[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(sales)
      .where(eq(sales.tenantId, tenantId))
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
}

export async function recordSale(
  tenantId: string,
  input: RecordSaleInput,
): Promise<{ saleId: string }> {
  return withTenant(tenantId, async (tx) => {
    const [product] = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, input.productId)))
      .limit(1);
    if (!product) throw new Error("المنتج غير موجود");
    if (product.quantity < input.quantitySold) {
      throw new Error("الكمية المطلوبة غير متوفرة في المخزن");
    }

    const subtotal = input.quantitySold * input.pricePerUnit;
    let discountAmount = 0;
    if (input.discountType && input.discountValue && input.discountValue > 0) {
      discountAmount =
        input.discountType === "percentage"
          ? Math.round((subtotal * input.discountValue) / 100)
          : input.discountValue;
    }
    discountAmount = Math.min(discountAmount, subtotal);
    const totalPrice = subtotal - discountAmount;
    const nextQty = product.quantity - input.quantitySold;

    await tx
      .update(products)
      .set({ quantity: nextQty, updatedAt: new Date() })
      .where(and(eq(products.tenantId, tenantId), eq(products.id, input.productId)));

    const attrs = await loadAttributeSnapshot(tx, tenantId, input.productId);
    const paymentMethod: PaymentMethod = input.paymentMethod || "cash";

    const [created] = await tx
      .insert(sales)
      .values({
        tenantId,
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
      })
      .returning({ id: sales.id });

    await tx.insert(productHistory).values({
      tenantId,
      productId: input.productId,
      productName: product.name,
      type: "sold",
      delta: -input.quantitySold,
      quantityAfter: nextQty,
    });

    return { saleId: created.id };
  });
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
}

export interface CartSaleResult {
  invoiceId: string;
  saleIds: string[];
}

export async function recordCartSale(
  tenantId: string,
  lines: CartSaleLineInput[],
  options: CartSaleOptions = {},
): Promise<CartSaleResult> {
  if (lines.length === 0) throw new Error("الفاتورة فارغة");
  const invoiceId = makeInvoiceId();
  const saleDate = options.customDate ?? new Date();
  const paymentMethod: PaymentMethod = options.paymentMethod || "cash";

  return withTenant(tenantId, async (tx) => {
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
      if (p.quantity < line.quantity) {
        throw new Error(
          `الكمية المطلوبة من "${p.name}" غير متوفرة (المتاح ${p.quantity})`,
        );
      }

      const lineSubtotal = line.quantity * line.pricePerUnit;
      let lineDiscount = 0;
      if (
        line.lineDiscountType &&
        line.lineDiscountValue &&
        line.lineDiscountValue > 0
      ) {
        lineDiscount =
          line.lineDiscountType === "percentage"
            ? Math.round((lineSubtotal * line.lineDiscountValue) / 100)
            : line.lineDiscountValue;
      }
      lineDiscount = Math.min(lineDiscount, lineSubtotal);
      cartGross += lineSubtotal - lineDiscount;

      const attrs = await loadAttributeSnapshot(tx, tenantId, line.productId);
      pre.push({ line, product: p, attrs, lineSubtotal, lineDiscount });
    }

    let orderDiscountTotal = 0;
    if (
      options.orderDiscountType &&
      typeof options.orderDiscountValue === "number" &&
      options.orderDiscountValue > 0 &&
      cartGross > 0
    ) {
      orderDiscountTotal =
        options.orderDiscountType === "percentage"
          ? Math.round((cartGross * options.orderDiscountValue) / 100)
          : options.orderDiscountValue;
      orderDiscountTotal = Math.min(orderDiscountTotal, cartGross);
    }

    const saleIds: string[] = [];
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
      const nextQty = p.product.quantity - p.line.quantity;

      await tx
        .update(products)
        .set({ quantity: nextQty, updatedAt: new Date() })
        .where(
          and(eq(products.tenantId, tenantId), eq(products.id, p.line.productId)),
        );

      const [created] = await tx
        .insert(sales)
        .values({
          tenantId,
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
        })
        .returning({ id: sales.id });

      saleIds.push(created.id);

      await tx.insert(productHistory).values({
        tenantId,
        productId: p.line.productId,
        productName: p.product.name,
        type: "sold",
        delta: -p.line.quantity,
        quantityAfter: nextQty,
      });
    }

    return { invoiceId, saleIds };
  });
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

export async function listReturns(tenantId: string): Promise<Return[]> {
  return withTenant(tenantId, async (tx) => {
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
  return withTenant(tenantId, async (tx) => {
    const [sale] = await tx
      .select()
      .from(sales)
      .where(and(eq(sales.tenantId, tenantId), eq(sales.id, input.saleId)))
      .limit(1);
    if (!sale) throw new Error("البيع غير موجود");

    await tx
      .update(products)
      .set({
        quantity: sql`${products.quantity} + ${input.returnedQuantity}`,
        updatedAt: new Date(),
      })
      .where(and(eq(products.tenantId, tenantId), eq(products.id, input.productId)));

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
}

// ─────────────────────────────────────────────────────────────────────────────
// Expenses
// ─────────────────────────────────────────────────────────────────────────────

export async function listExpenses(tenantId: string): Promise<Expense[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(expensesTable)
      .where(eq(expensesTable.tenantId, tenantId))
      .orderBy(desc(expensesTable.date));
    return rows.map(rowToExpense);
  });
}

export interface AddExpenseInput {
  title: string;
  amount: number;
  category: ExpenseCategory;
  supplierId?: string | null;
  date?: Date;
  note?: string;
}

export async function addExpense(
  tenantId: string,
  input: AddExpenseInput,
): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    const [created] = await tx
      .insert(expensesTable)
      .values({
        tenantId,
        title: input.title,
        amount: String(input.amount),
        category: input.category,
        supplierId: input.supplierId ?? null,
        date: input.date ?? new Date(),
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
}
