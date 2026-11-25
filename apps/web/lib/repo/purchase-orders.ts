import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  purchaseOrders,
  purchaseOrderItems,
  products,
  productHistory,
  suppliers,
  branches,
  categories,
} from "@/lib/db/schema";
import { adjustSupplierBalance } from "./suppliers";
import { _recordPaymentTx } from "./purchase-payments";
import { fanoutEvent } from "@/lib/notifications/dispatch";

export type PurchaseOrderStatus = "draft" | "received" | "cancelled";

export interface PurchaseOrderItem {
  id: string;
  productId: string | null;
  productName: string;
  quantity: number;
  unitCost: number;
  lineTotal: number;
}

export interface PurchaseOrderSummary {
  id: string;
  supplierId: string;
  supplierName: string;
  status: PurchaseOrderStatus;
  orderDate: Date;
  receivedDate: Date | null;
  notes: string | null;
  total: number;
  paidAmount: number;
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PurchaseOrderDetail extends PurchaseOrderSummary {
  items: PurchaseOrderItem[];
}

export class PurchaseOrderConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseOrderConflictError";
  }
}

export async function listPurchaseOrders(
  tenantId: string,
  filters?: { supplierId?: string; status?: PurchaseOrderStatus },
): Promise<PurchaseOrderSummary[]> {
  return withTenant(tenantId, async (tx) => {
    const conditions = [eq(purchaseOrders.tenantId, tenantId)];
    if (filters?.supplierId) conditions.push(eq(purchaseOrders.supplierId, filters.supplierId));
    if (filters?.status) conditions.push(eq(purchaseOrders.status, filters.status));

    const rows = await tx
      .select({
        po: purchaseOrders,
        supplierName: suppliers.name,
        itemCount: sql<number>`(
          select count(*)::int from ${purchaseOrderItems}
          where ${purchaseOrderItems.purchaseOrderId} = ${purchaseOrders.id}
        )`,
      })
      .from(purchaseOrders)
      .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
      .where(and(...conditions))
      .orderBy(desc(purchaseOrders.orderDate));

    return rows.map((r) => ({
      id: r.po.id,
      supplierId: r.po.supplierId,
      supplierName: r.supplierName,
      status: r.po.status as PurchaseOrderStatus,
      orderDate: r.po.orderDate,
      receivedDate: r.po.receivedDate,
      notes: r.po.notes,
      total: Number(r.po.total),
      paidAmount: Number(r.po.paidAmount),
      itemCount: r.itemCount,
      createdAt: r.po.createdAt,
      updatedAt: r.po.updatedAt,
    }));
  });
}

export async function getPurchaseOrder(
  tenantId: string,
  id: string,
): Promise<PurchaseOrderDetail | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        po: purchaseOrders,
        supplierName: suppliers.name,
      })
      .from(purchaseOrders)
      .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.id, id)))
      .limit(1);
    if (!row) return null;

    const items = await tx
      .select()
      .from(purchaseOrderItems)
      .where(
        and(
          eq(purchaseOrderItems.tenantId, tenantId),
          eq(purchaseOrderItems.purchaseOrderId, id),
        ),
      )
      .orderBy(asc(purchaseOrderItems.productName));

    return {
      id: row.po.id,
      supplierId: row.po.supplierId,
      supplierName: row.supplierName,
      status: row.po.status as PurchaseOrderStatus,
      orderDate: row.po.orderDate,
      receivedDate: row.po.receivedDate,
      notes: row.po.notes,
      total: Number(row.po.total),
      paidAmount: Number(row.po.paidAmount),
      itemCount: items.length,
      createdAt: row.po.createdAt,
      updatedAt: row.po.updatedAt,
      items: items.map((i) => ({
        id: i.id,
        productId: i.productId,
        productName: i.productName,
        quantity: i.quantity,
        unitCost: Number(i.unitCost),
        lineTotal: Number(i.lineTotal),
      })),
    };
  });
}

export interface CreatePurchaseOrderItem {
  productId: string | null;
  productName: string;
  quantity: number;
  unitCost: number;
  /** Only meaningful for external (productId=null) lines — files the
   *  materialised product into this category on receive. */
  categoryId?: string;
}

export interface CreatePurchaseOrderInput {
  supplierId: string;
  notes?: string | null;
  items: CreatePurchaseOrderItem[];
}

export async function createPurchaseOrder(
  tenantId: string,
  input: CreatePurchaseOrderInput,
): Promise<{ id: string }> {
  if (input.items.length === 0) {
    throw new PurchaseOrderConflictError("لا يمكن إنشاء أمر شراء بدون أصناف");
  }
  return withTenant(tenantId, async (tx) => {
    const total = input.items.reduce(
      (sum, i) => sum + i.quantity * i.unitCost,
      0,
    );

    const [created] = await tx
      .insert(purchaseOrders)
      .values({
        tenantId,
        supplierId: input.supplierId,
        status: "draft",
        notes: input.notes ?? null,
        total: total.toFixed(2),
      })
      .returning({ id: purchaseOrders.id });

    await tx.insert(purchaseOrderItems).values(
      input.items.map((i) => ({
        tenantId,
        purchaseOrderId: created.id,
        productId: i.productId,
        productName: i.productName,
        quantity: i.quantity,
        unitCost: i.unitCost.toFixed(2),
        lineTotal: (i.quantity * i.unitCost).toFixed(2),
        categoryId: i.categoryId ?? null,
      })),
    );

    return { id: created.id };
  });
}

export async function updatePurchaseOrderNotes(
  tenantId: string,
  id: string,
  notes: string | null,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(purchaseOrders)
      .set({ notes, updatedAt: sql`now()` })
      .where(
        and(
          eq(purchaseOrders.tenantId, tenantId),
          eq(purchaseOrders.id, id),
          eq(purchaseOrders.status, "draft"),
        ),
      );
  });
}

export async function cancelPurchaseOrder(
  tenantId: string,
  id: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [po] = await tx
      .select({ status: purchaseOrders.status })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.id, id)))
      .limit(1);
    if (!po) return;
    if (po.status === "received") {
      throw new PurchaseOrderConflictError("لا يمكن إلغاء أمر شراء تم استلامه");
    }
    await tx
      .update(purchaseOrders)
      .set({ status: "cancelled", updatedAt: sql`now()` })
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.id, id)));
  });
}

export async function deletePurchaseOrder(
  tenantId: string,
  id: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [po] = await tx
      .select({ status: purchaseOrders.status })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.id, id)))
      .limit(1);
    if (!po) return;
    if (po.status === "received") {
      throw new PurchaseOrderConflictError(
        "لا يمكن حذف أمر شراء تم استلامه — قم بإلغائه فقط",
      );
    }
    await tx
      .delete(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.id, id)));
  });
}

/**
 * Atomic receive: marks the PO as received, increments stock for every line
 * item that points at an existing product, writes a "restocked" history row,
 * and increments the supplier's balance by the PO total.
 *
 * `updateCost: true` also overwrites each affected product's cost_price with
 * the latest unit cost from the PO so future margin calculations reflect the
 * new buy price.
 */
/**
 * Tx-scoped receive. Does everything receivePurchaseOrder does EXCEPT opening
 * the outer `withTenant` and firing the post-commit `fanoutEvent`. Returns the
 * summary the caller needs for fan-out.
 *
 * Extracted so composite orchestrators (e.g. AI "create + receive + pay in
 * one preview") can share the single transaction with createPurchaseOrder +
 * recordPayment without rebuilding this logic. Public callers use
 * receivePurchaseOrder below, which keeps behaviour identical.
 */
export async function _receivePurchaseOrderTx(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  id: string,
  options: { updateCost?: boolean; actorUserId?: string | null } = {},
): Promise<{
  branchId: string | null;
  shortId: string;
  totalEgp: number;
  itemCount: number;
  supplierName: string | null;
  branchName: string | null;
}> {
  {
    const [po] = await tx
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.id, id)))
      .limit(1);
    if (!po) throw new PurchaseOrderConflictError("أمر الشراء غير موجود");
    if (po.status !== "draft") {
      throw new PurchaseOrderConflictError(
        po.status === "received"
          ? "هذا الأمر تم استلامه بالفعل"
          : "لا يمكن استلام أمر ملغي",
      );
    }

    const items = await tx
      .select()
      .from(purchaseOrderItems)
      .where(
        and(
          eq(purchaseOrderItems.tenantId, tenantId),
          eq(purchaseOrderItems.purchaseOrderId, id),
        ),
      );

    // Resolve the destination branch for external (productId=null) items.
    // External lines are receipts of goods that aren't in the catalog yet
    // — we promote them to real products so the stock lands somewhere
    // searchable + sellable. Priority:
    //   1. The PO's own branchId (if set)
    //   2. The tenant's primary branch
    //   3. The first branch (defensive — every tenant has at least one)
    let destBranchId: string | null = po.branchId;
    if (!destBranchId) {
      const [primary] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(
          and(
            eq(branches.tenantId, tenantId),
            eq(branches.isPrimary, true),
          ),
        )
        .limit(1);
      destBranchId = primary?.id ?? null;
      if (!destBranchId) {
        const [any] = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(eq(branches.tenantId, tenantId))
          .limit(1);
        destBranchId = any?.id ?? null;
      }
    }

    // Default category for the new products (`products.category_id` is
    // NOT NULL). Pick the first category for the tenant — used as
    // fallback when an external line didn't carry a per-line categoryId.
    let defaultCategoryId: string | null = null;
    if (items.some((i) => !i.productId)) {
      const [firstCat] = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.tenantId, tenantId))
        .orderBy(asc(categories.position))
        .limit(1);
      defaultCategoryId = firstCat?.id ?? null;
      if (!destBranchId || !defaultCategoryId) {
        throw new PurchaseOrderConflictError(
          "لا يمكن استلام أصناف خارجية: الفرع أو الصنف الافتراضي غير متوفر",
        );
      }
    }

    // Map of catalog products we'll be writing to. Keyed by product id.
    // Pre-loaded for items that already point at a real product; entries
    // for external items are added as we materialise them.
    const productIds = items
      .map((i) => i.productId)
      .filter((v): v is string => !!v);
    const productMap = new Map<string, { name: string; quantity: number }>();
    if (productIds.length > 0) {
      const rows = await tx
        .select({
          id: products.id,
          name: products.name,
          quantity: products.quantity,
        })
        .from(products)
        .where(
          and(
            eq(products.tenantId, tenantId),
            inArray(products.id, productIds),
          ),
        );
      for (const r of rows) productMap.set(r.id, { name: r.name, quantity: r.quantity });
    }

    // De-dup external items by trimmed-lowercase name (within this PO and
    // within the existing catalog at this branch). Two PO lines with the
    // same name shouldn't create two products — they should both stock
    // the same one.
    const externalByName = new Map<string, string>(); // name → productId

    for (const item of items) {
      let productId = item.productId;
      let productName = item.productName;
      let priorQty = 0;

      if (!productId) {
        // External item — promote to catalog.
        const nameKey = item.productName.trim().toLowerCase();
        if (!nameKey) continue; // defensive: empty name lines

        // Already materialised earlier in this same PO?
        const seen = externalByName.get(nameKey);
        if (seen) {
          productId = seen;
          priorQty = productMap.get(seen)?.quantity ?? 0;
        } else {
          // Try to find an existing catalog product with the same name
          // at the destination branch — case-insensitive. If found, we
          // restock that one instead of creating a duplicate.
          const [existing] = await tx
            .select({
              id: products.id,
              name: products.name,
              quantity: products.quantity,
              supplierId: products.supplierId,
            })
            .from(products)
            .where(
              and(
                eq(products.tenantId, tenantId),
                eq(products.branchId, destBranchId!),
                sql`lower(${products.name}) = ${nameKey}`,
              ),
            )
            .limit(1);

          if (existing) {
            productId = existing.id;
            productName = existing.name;
            priorQty = existing.quantity;
            productMap.set(existing.id, {
              name: existing.name,
              quantity: existing.quantity,
            });
            // Backfill supplierId on the matched product if it doesn't
            // have one — common path: the owner created the product via
            // a different flow (no supplier picked) and is restocking
            // via this PO. Don't overwrite an existing supplier link;
            // that's an explicit owner choice.
            if (!existing.supplierId && po.supplierId) {
              await tx
                .update(products)
                .set({ supplierId: po.supplierId })
                .where(
                  and(
                    eq(products.tenantId, tenantId),
                    eq(products.id, existing.id),
                  ),
                );
            }
          } else {
            // Create the new product. Defaults: selling price = cost price
            // (zero markup; owner can adjust later from /inventory), low
            // stock threshold = 3 (the catalog default). The PO's
            // supplierId is copied through so the new product is linked
            // to the same supplier in /inventory — keeps the books +
            // catalog consistent without an extra edit.
            //
            // Category: the per-line owner-picked categoryId wins. Falls
            // back to the tenant's first category if absent.
            const [created] = await tx
              .insert(products)
              .values({
                tenantId,
                branchId: destBranchId!,
                categoryId: item.categoryId ?? defaultCategoryId!,
                name: item.productName.trim(),
                quantity: 0,
                price: item.unitCost,
                costPrice: item.unitCost,
                lowStockThreshold: 3,
                supplierId: po.supplierId,
              })
              .returning({ id: products.id });
            productId = created.id;
            productName = item.productName.trim();
            priorQty = 0;
            productMap.set(productId, { name: productName, quantity: 0 });
          }
          externalByName.set(nameKey, productId);
        }

        // Link the PO line to the new/found product so audits + future
        // receives see a real productId, not a phantom string.
        await tx
          .update(purchaseOrderItems)
          .set({ productId })
          .where(
            and(
              eq(purchaseOrderItems.tenantId, tenantId),
              eq(purchaseOrderItems.id, item.id),
            ),
          );
      } else {
        const existing = productMap.get(productId);
        if (!existing) continue;
        productName = existing.name;
        priorQty = existing.quantity;
      }

      const next = priorQty + item.quantity;

      const set: Record<string, unknown> = {
        quantity: next,
        updatedAt: sql`now()`,
      };
      if (options.updateCost) {
        set.costPrice = item.unitCost;
      }

      await tx
        .update(products)
        .set(set)
        .where(
          and(eq(products.tenantId, tenantId), eq(products.id, productId)),
        );

      // Keep the map in sync for repeated lines on the same product.
      productMap.set(productId, { name: productName, quantity: next });

      await tx.insert(productHistory).values({
        tenantId,
        productId,
        productName,
        type: "restocked",
        delta: item.quantity,
        quantityAfter: next,
        note: `أمر شراء #${id.slice(0, 8)}`,
      });
    }

    // Mark PO as received.
    await tx
      .update(purchaseOrders)
      .set({
        status: "received",
        receivedDate: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.id, id)));

    // Debit supplier balance (we now owe them the PO total).
    await adjustSupplierBalance(tx, tenantId, po.supplierId, Number(po.total));

    // Resolve supplier + branch names for the post-commit fanout so we
    // avoid a second round-trip after the tx closes.
    const [supplier] = await tx
      .select({ name: suppliers.name })
      .from(suppliers)
      .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, po.supplierId)))
      .limit(1);
    let branchName: string | null = null;
    if (po.branchId) {
      const [b] = await tx
        .select({ name: branches.name })
        .from(branches)
        .where(and(eq(branches.tenantId, tenantId), eq(branches.id, po.branchId)))
        .limit(1);
      branchName = b?.name ?? null;
    }

    return {
      branchId: po.branchId ?? null,
      shortId: id.slice(0, 8),
      totalEgp: Number(po.total),
      itemCount: items.length,
      supplierName: supplier?.name ?? null,
      branchName,
    };
  }
}

/** Public receive. Opens its own transaction, delegates to the tx-scoped
 *  inner, then fires the post-commit notification fanout. */
export async function receivePurchaseOrder(
  tenantId: string,
  id: string,
  options: { updateCost?: boolean; actorUserId?: string | null } = {},
): Promise<void> {
  const summary = await withTenant(tenantId, (tx) =>
    _receivePurchaseOrderTx(tx, tenantId, id, options),
  );

  void fanoutEvent(tenantId, summary.branchId, "purchase.received", {
    poShortId: summary.shortId,
    supplierName: summary.supplierName,
    totalEgp: summary.totalEgp,
    itemCount: summary.itemCount,
    branchName: summary.branchName,
    link: `/purchases/${id}`,
    actorUserId: options.actorUserId ?? null,
  });
}

/* ──────────────── Composite: create + receive + optional payment ──────────────── */

export interface CreateReceivedPurchaseInput {
  supplierId: string;
  items: CreatePurchaseOrderItem[];
  /** Immediate supplier payment to apply after receiving. 0 or undefined = pure credit. */
  paidNow?: number;
  /** Payment method; defaults to "cash" when `paidNow > 0` and left unset. */
  paymentMethod?: "cash" | "bank" | "vfcash" | "instapay" | "other";
  /** Free-text notes. The orchestrator appends an audit trailer. */
  notes?: string | null;
  /** When true (AI default), update each existing product's cost_price to the
   *  new unit cost — matches the Owner's mental model of "this is what I paid
   *  this time". Historical `cost_price_at_sale` snapshots are untouched. */
  updateCost?: boolean;
  /** Actor used for audit + the post-commit fanout. */
  actorUserId?: string | null;
  /** Suffix stamped into notes so auditors can see non-UI origins. */
  originTag?: string | null;
}

export interface CreateReceivedPurchaseResult {
  purchaseOrderId: string;
  total: number;
  paid: number;
  outstanding: number;
  paymentId: string | null;
}

/**
 * Atomic composite for the AI "اشتريت من حسين …" flow and any other caller
 * that needs create + receive + payment as ONE transaction. Rolls back the
 * entire thing on any failure — no half-finished PO, no stale stock delta,
 * no orphan supplier-balance adjustment.
 *
 * Internally composes the SAME three primitives the REST routes use:
 *   • createPurchaseOrder → draft
 *   • _receivePurchaseOrderTx → stock in, cost update, supplier balance
 *   • _recordPaymentTx → (optional) supplier settlement
 *
 * Post-commit fanout mirrors the stand-alone receivePurchaseOrder so a
 * notification/digest subscriber doesn't need to know about this path.
 */
export async function createReceivedPurchaseWithOptionalPayment(
  tenantId: string,
  input: CreateReceivedPurchaseInput,
): Promise<CreateReceivedPurchaseResult> {
  if (input.items.length === 0) {
    throw new PurchaseOrderConflictError("لا يمكن إنشاء أمر شراء بدون أصناف");
  }
  const paidNow = Math.round(Math.max(0, input.paidNow ?? 0) * 100) / 100;
  const expectedTotal =
    Math.round(input.items.reduce((s, i) => s + i.quantity * i.unitCost, 0) * 100) / 100;
  if (paidNow > expectedTotal + 0.001) {
    throw new PurchaseOrderConflictError(
      `المبلغ المدفوع (${paidNow.toFixed(2)}) أكبر من إجمالي الشراء (${expectedTotal.toFixed(2)})`,
    );
  }

  const notesTrailer = input.originTag ?? "via AI Agent";
  const notes = input.notes?.trim()
    ? `${input.notes.trim()} — ${notesTrailer}`
    : notesTrailer;

  const outcome = await withTenant(tenantId, async (tx) => {
    // 1) Create PO (draft).
    const [created] = await tx
      .insert(purchaseOrders)
      .values({
        tenantId,
        supplierId: input.supplierId,
        status: "draft",
        notes,
        total: expectedTotal.toFixed(2),
      })
      .returning({ id: purchaseOrders.id });
    const purchaseOrderId = created.id;

    await tx.insert(purchaseOrderItems).values(
      input.items.map((i) => ({
        tenantId,
        purchaseOrderId,
        productId: i.productId,
        productName: i.productName,
        quantity: i.quantity,
        unitCost: i.unitCost.toFixed(2),
        lineTotal: (i.quantity * i.unitCost).toFixed(2),
        categoryId: i.categoryId ?? null,
      })),
    );

    // 2) Receive — reuses the same tx; handles new-product materialisation,
    //    stock, cost snapshot, supplier balance += total.
    const summary = await _receivePurchaseOrderTx(tx, tenantId, purchaseOrderId, {
      updateCost: input.updateCost ?? true,
      actorUserId: input.actorUserId ?? null,
    });

    // 3) Optional immediate payment.
    let paymentId: string | null = null;
    if (paidNow > 0) {
      const res = await _recordPaymentTx(tx, tenantId, purchaseOrderId, {
        amount: paidNow,
        method: input.paymentMethod ?? "cash",
        notes: `via AI Agent`,
      });
      paymentId = res.id;
    }

    return {
      summary,
      purchaseOrderId,
      total: expectedTotal,
      paid: paidNow,
      outstanding: Math.round((expectedTotal - paidNow) * 100) / 100,
      paymentId,
    };
  });

  // Post-commit — fire the same fan-out receivePurchaseOrder does.
  void fanoutEvent(tenantId, outcome.summary.branchId, "purchase.received", {
    poShortId: outcome.summary.shortId,
    supplierName: outcome.summary.supplierName,
    totalEgp: outcome.summary.totalEgp,
    itemCount: outcome.summary.itemCount,
    branchName: outcome.summary.branchName,
    link: `/purchases/${outcome.purchaseOrderId}`,
    actorUserId: input.actorUserId ?? null,
  });

  return {
    purchaseOrderId: outcome.purchaseOrderId,
    total: outcome.total,
    paid: outcome.paid,
    outstanding: outcome.outstanding,
    paymentId: outcome.paymentId,
  };
}
