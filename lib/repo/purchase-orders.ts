import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  purchaseOrders,
  purchaseOrderItems,
  products,
  productHistory,
  suppliers,
} from "@/lib/db/schema";
import { adjustSupplierBalance } from "./suppliers";

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
export async function receivePurchaseOrder(
  tenantId: string,
  id: string,
  options: { updateCost?: boolean } = {},
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
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

    // Increment stock for each linked product.
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

    for (const item of items) {
      if (!item.productId) continue;
      const existing = productMap.get(item.productId);
      if (!existing) continue;
      const next = existing.quantity + item.quantity;

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
          and(eq(products.tenantId, tenantId), eq(products.id, item.productId)),
        );

      await tx.insert(productHistory).values({
        tenantId,
        productId: item.productId,
        productName: existing.name,
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
  });
}
