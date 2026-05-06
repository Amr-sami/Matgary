import { and, asc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { suppliers, products, expenses } from "@/lib/db/schema";
import type { SupplierDescriptor, SupplierInput } from "@/lib/types";

export class SupplierConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplierConflictError";
  }
}

function rowToDescriptor(row: typeof suppliers.$inferSelect): SupplierDescriptor {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    balance: Number(row.balance ?? "0"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listSuppliers(tenantId: string): Promise<SupplierDescriptor[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(suppliers)
      .where(eq(suppliers.tenantId, tenantId))
      .orderBy(asc(suppliers.name));
    return rows.map(rowToDescriptor);
  });
}

export async function getSupplier(
  tenantId: string,
  id: string,
): Promise<SupplierDescriptor | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, id)))
      .limit(1);
    return row ? rowToDescriptor(row) : null;
  });
}

export async function addSupplier(
  tenantId: string,
  input: SupplierInput,
): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    const [created] = await tx
      .insert(suppliers)
      .values({
        tenantId,
        name: input.name,
        phone: input.phone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        notes: input.notes ?? null,
      })
      .returning({ id: suppliers.id });
    return { id: created.id };
  });
}

export async function updateSupplier(
  tenantId: string,
  id: string,
  patch: Partial<SupplierInput>,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.phone !== undefined) set.phone = patch.phone;
    if (patch.email !== undefined) set.email = patch.email;
    if (patch.address !== undefined) set.address = patch.address;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (Object.keys(set).length === 1) return; // only updatedAt
    await tx
      .update(suppliers)
      .set(set)
      .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, id)));
  });
}

export async function deleteSupplier(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    // Block deletion if any product or expense references this supplier so the
    // user is forced to reassign instead of silently nulling those rows.
    const [{ count: productRefs }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.supplierId, id)));
    const [{ count: expenseRefs }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(expenses)
      .where(and(eq(expenses.tenantId, tenantId), eq(expenses.supplierId, id)));
    if (productRefs > 0 || expenseRefs > 0) {
      throw new SupplierConflictError(
        `لا يمكن الحذف: مرتبط بـ${productRefs} منتج و ${expenseRefs} مصاريف`,
      );
    }
    await tx
      .delete(suppliers)
      .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, id)));
  });
}

/**
 * Adjust a supplier's running balance. Positive delta = we now owe more
 * (e.g. PO received); negative = we paid them (e.g. expense booked).
 *
 * Must be called inside an existing `withTenant` transaction so it stays
 * atomic with whatever caused the change.
 */
export async function adjustSupplierBalance(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  supplierId: string,
  delta: number,
): Promise<void> {
  await tx
    .update(suppliers)
    .set({
      balance: sql`(${suppliers.balance})::numeric + ${delta.toFixed(2)}::numeric`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, supplierId)));
}
