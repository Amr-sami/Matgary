// Demo store cloning utility. Each visitor signs into an ephemeral tenant
// cloned from a single seeded template. createDemoClone() spins up the clone
// at first login; resetDemoClone() wipes + reclones it on every full page
// refresh so the visitor's edits never persist.
//
// Cloning runs through the admin pool (BYPASSRLS) so a single transaction can
// SELECT from the template tenant and INSERT into the new one. The per-table
// helpers remap UUID PKs and FKs in-memory so the clone's data graph is
// internally consistent without colliding with the template's PKs.

import "server-only";

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { getAdminDb } from "@/lib/admin/db";
import * as s from "@/lib/db/schema";

type Db = ReturnType<typeof getAdminDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type IdMap = Map<string, string>;

/** Tables we copy verbatim (per-tenant business data the visitor will touch).
 *  Anything not in this list starts empty in the clone — attendance, payroll,
 *  WhatsApp, notifications, and digest state are intentionally excluded since
 *  they don't add anything to a "feel the app" demo. */
async function copyTenantData(
  tx: Tx,
  opts: {
    fromTenantId: string;
    toTenantId: string;
    templateOwnerUserId: string | null;
    cloneOwnerUserId: string;
  },
): Promise<void> {
  const { fromTenantId, toTenantId, templateOwnerUserId, cloneOwnerUserId } = opts;

  // Remap a user_id column: any reference to the template owner becomes the
  // clone owner. Any other user reference becomes NULL (template's staff
  // doesn't get cloned, so leaving the old id would dangle). Returns
  // `undefined` so the value falls through to the column default if nullable.
  const remapUser = (oldId: string | null | undefined): string | null => {
    if (!oldId) return null;
    if (templateOwnerUserId && oldId === templateOwnerUserId) return cloneOwnerUserId;
    return null;
  };

  // ── 1. branches ──────────────────────────────────────────────────────────
  const oldBranches = await tx.select().from(s.branches).where(eq(s.branches.tenantId, fromTenantId));
  const branchMap: IdMap = new Map();
  if (oldBranches.length) {
    const rows = oldBranches.map((b) => {
      const newId = randomUUID();
      branchMap.set(b.id, newId);
      return { ...b, id: newId, tenantId: toTenantId };
    });
    await tx.insert(s.branches).values(rows);
  }

  // ── 2. categories ────────────────────────────────────────────────────────
  const oldCategories = await tx.select().from(s.categories).where(eq(s.categories.tenantId, fromTenantId));
  const categoryMap: IdMap = new Map();
  if (oldCategories.length) {
    const rows = oldCategories.map((c) => {
      const newId = randomUUID();
      categoryMap.set(c.id, newId);
      return {
        ...c,
        id: newId,
        tenantId: toTenantId,
        branchId: branchMap.get(c.branchId) ?? c.branchId,
      };
    });
    await tx.insert(s.categories).values(rows);
  }

  // ── 3. brands ────────────────────────────────────────────────────────────
  const oldBrands = await tx.select().from(s.brands).where(eq(s.brands.tenantId, fromTenantId));
  const brandMap: IdMap = new Map();
  if (oldBrands.length) {
    const rows = oldBrands.map((b) => {
      const newId = randomUUID();
      brandMap.set(b.id, newId);
      return {
        ...b,
        id: newId,
        tenantId: toTenantId,
        branchId: branchMap.get(b.branchId) ?? b.branchId,
        categoryId: b.categoryId ? categoryMap.get(b.categoryId) ?? b.categoryId : b.categoryId,
      };
    });
    await tx.insert(s.brands).values(rows);
  }

  // ── 4. suppliers ─────────────────────────────────────────────────────────
  const oldSuppliers = await tx.select().from(s.suppliers).where(eq(s.suppliers.tenantId, fromTenantId));
  const supplierMap: IdMap = new Map();
  if (oldSuppliers.length) {
    const rows = oldSuppliers.map((sup) => {
      const newId = randomUUID();
      supplierMap.set(sup.id, newId);
      return {
        ...sup,
        id: newId,
        tenantId: toTenantId,
        branchId: branchMap.get(sup.branchId) ?? sup.branchId,
      };
    });
    await tx.insert(s.suppliers).values(rows);
  }

  // ── 5. products ──────────────────────────────────────────────────────────
  const oldProducts = await tx.select().from(s.products).where(eq(s.products.tenantId, fromTenantId));
  const productMap: IdMap = new Map();
  if (oldProducts.length) {
    const rows = oldProducts.map((p) => {
      const newId = randomUUID();
      productMap.set(p.id, newId);
      return {
        ...p,
        id: newId,
        tenantId: toTenantId,
        branchId: branchMap.get(p.branchId) ?? p.branchId,
        categoryId: categoryMap.get(p.categoryId) ?? p.categoryId,
        supplierId: p.supplierId ? supplierMap.get(p.supplierId) ?? null : null,
      };
    });
    await tx.insert(s.products).values(rows);
  }

  // ── 6. shop_settings (composite PK: tenant_id + branch_id) ───────────────
  const oldSettings = await tx
    .select()
    .from(s.shopSettings)
    .where(eq(s.shopSettings.tenantId, fromTenantId));
  if (oldSettings.length) {
    const rows = oldSettings.map((ss) => ({
      ...ss,
      tenantId: toTenantId,
      branchId: branchMap.get(ss.branchId) ?? ss.branchId,
    }));
    await tx.insert(s.shopSettings).values(rows);
  }

  // ── 7. cash_shifts ───────────────────────────────────────────────────────
  const oldShifts = await tx.select().from(s.cashShifts).where(eq(s.cashShifts.tenantId, fromTenantId));
  const shiftMap: IdMap = new Map();
  if (oldShifts.length) {
    const rows = oldShifts.map((cs) => {
      const newId = randomUUID();
      shiftMap.set(cs.id, newId);
      // `variance` is a Postgres generated column — strip it so the insert
      // doesn't trip "cannot insert into generated column".
      const { variance: _variance, ...rest } = cs;
      void _variance;
      return {
        ...rest,
        id: newId,
        tenantId: toTenantId,
        branchId: branchMap.get(cs.branchId) ?? cs.branchId,
        cashierUserId: remapUser(cs.cashierUserId) ?? cloneOwnerUserId,
        openedByUserId: remapUser(cs.openedByUserId) ?? cloneOwnerUserId,
        closedByUserId: remapUser(cs.closedByUserId),
        reviewedByUserId: remapUser(cs.reviewedByUserId),
      };
    });
    await tx.insert(s.cashShifts).values(rows);
  }

  // ── 8. cash_movements ────────────────────────────────────────────────────
  const oldMovements = await tx
    .select()
    .from(s.cashMovements)
    .where(eq(s.cashMovements.tenantId, fromTenantId));
  if (oldMovements.length) {
    const rows = oldMovements.map((m) => ({
      ...m,
      id: randomUUID(),
      tenantId: toTenantId,
      shiftId: shiftMap.get(m.shiftId) ?? m.shiftId,
      recordedByUserId: remapUser(m.recordedByUserId) ?? cloneOwnerUserId,
    }));
    await tx.insert(s.cashMovements).values(rows);
  }

  // ── 9. customer_wallets (composite PK: tenant + branch + phone) ──────────
  const oldWallets = await tx
    .select()
    .from(s.customerWallets)
    .where(eq(s.customerWallets.tenantId, fromTenantId));
  if (oldWallets.length) {
    const rows = oldWallets.map((w) => ({
      ...w,
      tenantId: toTenantId,
      branchId: branchMap.get(w.branchId) ?? w.branchId,
    }));
    await tx.insert(s.customerWallets).values(rows);
  }

  // ── 10. customer_wallet_events ───────────────────────────────────────────
  const oldWalletEvents = await tx
    .select()
    .from(s.customerWalletEvents)
    .where(eq(s.customerWalletEvents.tenantId, fromTenantId));
  if (oldWalletEvents.length) {
    const rows = oldWalletEvents.map((e) => ({
      ...e,
      id: randomUUID(),
      tenantId: toTenantId,
      branchId: branchMap.get(e.branchId) ?? e.branchId,
    }));
    await tx.insert(s.customerWalletEvents).values(rows);
  }

  // ── 11. expenses ─────────────────────────────────────────────────────────
  const oldExpenses = await tx.select().from(s.expenses).where(eq(s.expenses.tenantId, fromTenantId));
  if (oldExpenses.length) {
    const rows = oldExpenses.map((e) => ({
      ...e,
      id: randomUUID(),
      tenantId: toTenantId,
      branchId: e.branchId ? branchMap.get(e.branchId) ?? e.branchId : null,
      supplierId: e.supplierId ? supplierMap.get(e.supplierId) ?? null : null,
      cashShiftId: e.cashShiftId ? shiftMap.get(e.cashShiftId) ?? null : null,
    }));
    await tx.insert(s.expenses).values(rows);
  }

  // ── 12. purchase_orders ──────────────────────────────────────────────────
  const oldPOs = await tx.select().from(s.purchaseOrders).where(eq(s.purchaseOrders.tenantId, fromTenantId));
  const poMap: IdMap = new Map();
  if (oldPOs.length) {
    const rows = oldPOs.map((po) => {
      const newId = randomUUID();
      poMap.set(po.id, newId);
      return {
        ...po,
        id: newId,
        tenantId: toTenantId,
        branchId: po.branchId ? branchMap.get(po.branchId) ?? po.branchId : null,
        supplierId: supplierMap.get(po.supplierId) ?? po.supplierId,
      };
    });
    await tx.insert(s.purchaseOrders).values(rows);
  }

  // ── 13. purchase_order_items ─────────────────────────────────────────────
  const oldPOItems = await tx
    .select()
    .from(s.purchaseOrderItems)
    .where(eq(s.purchaseOrderItems.tenantId, fromTenantId));
  if (oldPOItems.length) {
    const rows = oldPOItems.map((it) => ({
      ...it,
      id: randomUUID(),
      tenantId: toTenantId,
      purchaseOrderId: poMap.get(it.purchaseOrderId) ?? it.purchaseOrderId,
      productId: it.productId ? productMap.get(it.productId) ?? null : null,
      categoryId: it.categoryId ? categoryMap.get(it.categoryId) ?? null : null,
    }));
    await tx.insert(s.purchaseOrderItems).values(rows);
  }

  // ── 14. purchase_order_payments ──────────────────────────────────────────
  const oldPOPayments = await tx
    .select()
    .from(s.purchaseOrderPayments)
    .where(eq(s.purchaseOrderPayments.tenantId, fromTenantId));
  if (oldPOPayments.length) {
    const rows = oldPOPayments.map((p) => ({
      ...p,
      id: randomUUID(),
      tenantId: toTenantId,
      branchId: p.branchId ? branchMap.get(p.branchId) ?? p.branchId : null,
      purchaseOrderId: poMap.get(p.purchaseOrderId) ?? p.purchaseOrderId,
      supplierId: supplierMap.get(p.supplierId) ?? p.supplierId,
    }));
    await tx.insert(s.purchaseOrderPayments).values(rows);
  }

  // ── 15. sales ────────────────────────────────────────────────────────────
  const oldSales = await tx.select().from(s.sales).where(eq(s.sales.tenantId, fromTenantId));
  const saleMap: IdMap = new Map();
  if (oldSales.length) {
    const rows = oldSales.map((sa) => {
      const newId = randomUUID();
      saleMap.set(sa.id, newId);
      return {
        ...sa,
        id: newId,
        tenantId: toTenantId,
        branchId: sa.branchId ? branchMap.get(sa.branchId) ?? sa.branchId : null,
        productId: productMap.get(sa.productId) ?? sa.productId,
        categoryId: categoryMap.get(sa.categoryId) ?? sa.categoryId,
        recordedByUserId: remapUser(sa.recordedByUserId),
        cashShiftId: sa.cashShiftId ? shiftMap.get(sa.cashShiftId) ?? null : null,
      };
    });
    await tx.insert(s.sales).values(rows);
  }

  // ── 16. sale_payments ────────────────────────────────────────────────────
  const oldSalePayments = await tx
    .select()
    .from(s.salePayments)
    .where(eq(s.salePayments.tenantId, fromTenantId));
  if (oldSalePayments.length) {
    const rows = oldSalePayments.map((p) => ({
      ...p,
      id: randomUUID(),
      tenantId: toTenantId,
      saleId: saleMap.get(p.saleId) ?? p.saleId,
      recordedByUserId: remapUser(p.recordedByUserId),
      cashShiftId: p.cashShiftId ? shiftMap.get(p.cashShiftId) ?? null : null,
    }));
    await tx.insert(s.salePayments).values(rows);
  }

  // ── 17. returns ──────────────────────────────────────────────────────────
  const oldReturns = await tx.select().from(s.returns).where(eq(s.returns.tenantId, fromTenantId));
  if (oldReturns.length) {
    const rows = oldReturns.map((r) => ({
      ...r,
      id: randomUUID(),
      tenantId: toTenantId,
      saleId: saleMap.get(r.saleId) ?? r.saleId,
      productId: productMap.get(r.productId) ?? r.productId,
      cashShiftId: r.cashShiftId ? shiftMap.get(r.cashShiftId) ?? null : null,
    }));
    await tx.insert(s.returns).values(rows);
  }

  // ── 18. tasks ────────────────────────────────────────────────────────────
  const oldTasks = await tx.select().from(s.tasks).where(eq(s.tasks.tenantId, fromTenantId));
  if (oldTasks.length) {
    const rows = oldTasks.map((t) => ({
      ...t,
      id: randomUUID(),
      tenantId: toTenantId,
      branchId: branchMap.get(t.branchId) ?? t.branchId,
    }));
    await tx.insert(s.tasks).values(rows);
  }

  // ── 19. activity_logs ────────────────────────────────────────────────────
  const oldActivity = await tx
    .select()
    .from(s.activityLogs)
    .where(eq(s.activityLogs.tenantId, fromTenantId));
  if (oldActivity.length) {
    const rows = oldActivity.map((a) => ({
      ...a,
      id: randomUUID(),
      tenantId: toTenantId,
      branchId: a.branchId ? branchMap.get(a.branchId) ?? a.branchId : null,
    }));
    await tx.insert(s.activityLogs).values(rows);
  }

  // ── 20. subscriptions — create a FRESH active subscription so the demo
  //    visitor passes the billing gate without dragging in template state.
  //    Far-future period end keeps ensureSubscription() reporting active.
  const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 50);
  await tx.insert(s.subscriptions).values({
    tenantId: toTenantId,
    plan: "professional",
    status: "active",
    trialEndsAt: new Date(),
    currentPeriodStart: new Date(),
    currentPeriodEndsAt: farFuture,
    amountEgp: "0",
  });
}

export interface CreateDemoCloneOpts {
  templateId: string;
  ownerUserId: string;
  locale: "ar" | "en";
}

/** Create a fresh demo tenant cloned from the template. */
export async function createDemoClone(opts: CreateDemoCloneOpts): Promise<{
  tenantId: string;
  slug: string;
}> {
  const db = getAdminDb();
  const [template] = await db
    .select()
    .from(s.tenants)
    .where(eq(s.tenants.id, opts.templateId))
    .limit(1);
  if (!template) throw new Error(`Demo template ${opts.templateId} not found`);
  if (!template.isDemo) throw new Error(`Tenant ${opts.templateId} is not flagged is_demo`);

  const templateOwnerUserId = await fetchTemplateOwnerId(db, opts.templateId);

  const newTenantId = randomUUID();
  const slug = `demo-${newTenantId.slice(0, 8)}`;

  await db.transaction(async (tx) => {
    await tx.insert(s.tenants).values({
      id: newTenantId,
      name: template.name,
      slug,
      currency: template.currency,
      language: opts.locale,
      timezone: template.timezone,
      isDemo: true,
      demoTemplateId: opts.templateId,
      demoLastActiveAt: new Date(),
    });
    await tx.insert(s.tenantMembers).values({
      tenantId: newTenantId,
      userId: opts.ownerUserId,
      role: "owner",
    });
    await copyTenantData(tx, {
      fromTenantId: opts.templateId,
      toTenantId: newTenantId,
      templateOwnerUserId,
      cloneOwnerUserId: opts.ownerUserId,
    });
  });

  return { tenantId: newTenantId, slug };
}

// Per-clone advisory lock — held for the duration of the surrounding
// transaction so concurrent reset + delete on the same clone serialize
// cleanly instead of deadlocking on cascaded child rows.
async function acquireDemoLock(tx: Tx, cloneId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('demo:' || ${cloneId}::text, 0))`,
  );
}

/** Wipe a demo clone's child rows and re-clone from its template. The tenant
 *  row + tenant_members row are preserved so the visitor's JWT stays valid.
 *  Returns silently if the clone has already been deleted (e.g. by the exit
 *  endpoint) — happens during the brief window where an in-flight request
 *  races with the cookie clear. Uses an advisory lock so concurrent reset
 *  + delete on the same clone serialize cleanly instead of deadlocking. */
export async function resetDemoClone(opts: {
  cloneId: string;
  ownerUserId: string;
}): Promise<void> {
  const db = getAdminDb();
  const [clone] = await db
    .select()
    .from(s.tenants)
    .where(eq(s.tenants.id, opts.cloneId))
    .limit(1);
  if (!clone) return;
  if (!clone.demoTemplateId) {
    throw new Error(`Tenant ${opts.cloneId} is not a demo clone — refusing to wipe`);
  }
  const templateId = clone.demoTemplateId;
  const templateOwnerUserId = await fetchTemplateOwnerId(db, templateId);

  await db.transaction(async (tx) => {
    // Serialize per-clone with an advisory lock — released on COMMIT/ROLLBACK.
    // Without this, a concurrent reset + delete cascade can deadlock on the
    // 20+ child tables that all cascade off `tenants.id`.
    await acquireDemoLock(tx, opts.cloneId);
    // Re-check after acquiring the lock — the other transaction may have
    // deleted the clone in the meantime.
    const [stillThere] = await tx
      .select({ id: s.tenants.id })
      .from(s.tenants)
      .where(eq(s.tenants.id, opts.cloneId))
      .limit(1);
    if (!stillThere) return;
    await wipeTenantChildRows(tx, opts.cloneId);
    await copyTenantData(tx, {
      fromTenantId: templateId,
      toTenantId: opts.cloneId,
      templateOwnerUserId,
      cloneOwnerUserId: opts.ownerUserId,
    });
    await tx
      .update(s.tenants)
      .set({ demoLastActiveAt: new Date() })
      .where(eq(s.tenants.id, opts.cloneId));
  });
}

/** Bump the idle clock so the cleanup cron won't delete a still-active demo. */
export async function touchDemoClone(cloneId: string): Promise<void> {
  const db = getAdminDb();
  await db
    .update(s.tenants)
    .set({ demoLastActiveAt: new Date() })
    .where(eq(s.tenants.id, cloneId));
}

async function fetchTemplateOwnerId(db: Db, templateId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: s.tenantMembers.userId })
    .from(s.tenantMembers)
    .where(eq(s.tenantMembers.tenantId, templateId))
    .limit(1);
  return row?.userId ?? null;
}

/** Delete the clone's child data in dependency-safe order. Could rely on FK
 *  cascade by dropping the tenants row, but that would invalidate the
 *  visitor's JWT — instead we preserve the tenant row and wipe under it. */
async function wipeTenantChildRows(tx: Tx, tenantId: string): Promise<void> {
  await tx.delete(s.activityLogs).where(eq(s.activityLogs.tenantId, tenantId));
  await tx.delete(s.returns).where(eq(s.returns.tenantId, tenantId));
  await tx.delete(s.salePayments).where(eq(s.salePayments.tenantId, tenantId));
  await tx.delete(s.sales).where(eq(s.sales.tenantId, tenantId));
  await tx.delete(s.purchaseOrderPayments).where(eq(s.purchaseOrderPayments.tenantId, tenantId));
  await tx.delete(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.tenantId, tenantId));
  await tx.delete(s.purchaseOrders).where(eq(s.purchaseOrders.tenantId, tenantId));
  await tx.delete(s.expenses).where(eq(s.expenses.tenantId, tenantId));
  await tx.delete(s.tasks).where(eq(s.tasks.tenantId, tenantId));
  await tx.delete(s.customerWalletEvents).where(eq(s.customerWalletEvents.tenantId, tenantId));
  await tx.delete(s.customerWallets).where(eq(s.customerWallets.tenantId, tenantId));
  await tx.delete(s.cashMovements).where(eq(s.cashMovements.tenantId, tenantId));
  await tx.delete(s.cashShifts).where(eq(s.cashShifts.tenantId, tenantId));
  await tx.delete(s.shopSettings).where(eq(s.shopSettings.tenantId, tenantId));
  await tx.delete(s.products).where(eq(s.products.tenantId, tenantId));
  await tx.delete(s.suppliers).where(eq(s.suppliers.tenantId, tenantId));
  await tx.delete(s.brands).where(eq(s.brands.tenantId, tenantId));
  await tx.delete(s.categories).where(eq(s.categories.tenantId, tenantId));
  await tx.delete(s.branches).where(eq(s.branches.tenantId, tenantId));
  await tx.delete(s.subscriptions).where(eq(s.subscriptions.tenantId, tenantId));
}

/** Helper for the demo-login route. Returns the singleton template's id (or
 *  null if the template hasn't been seeded yet). */
export async function findDemoTemplate(): Promise<{ id: string; ownerUserId: string | null } | null> {
  const db = getAdminDb();
  const [row] = await db
    .select({ id: s.tenants.id })
    .from(s.tenants)
    .where(sql`${s.tenants.isDemo} = true AND ${s.tenants.demoTemplateId} IS NULL`)
    .limit(1);
  if (!row) return null;
  const ownerUserId = await fetchTemplateOwnerId(db, row.id);
  return { id: row.id, ownerUserId };
}

/** Tenant-deletion helper used by /api/demo/exit and the cleanup cron.
 *  Drops the tenants row; FK CASCADE removes every child. Wrapped in the
 *  same advisory lock as resetDemoClone() so a concurrent reset queues
 *  behind the delete instead of deadlocking on cascaded child rows. */
export async function deleteDemoClone(cloneId: string): Promise<void> {
  const db = getAdminDb();
  await db.transaction(async (tx) => {
    await acquireDemoLock(tx, cloneId);
    await tx.delete(s.tenants).where(
      sql`${s.tenants.id} = ${cloneId} AND ${s.tenants.demoTemplateId} IS NOT NULL`,
    );
  });
}

/** Cleanup: delete idle demo clones older than maxIdleMs. Returns count. */
export async function cleanupIdleDemoClones(maxIdleMs = 60 * 60 * 1000): Promise<number> {
  const db = getAdminDb();
  const cutoff = new Date(Date.now() - maxIdleMs);
  // `${cutoff.toISOString()}::timestamptz`, not `${cutoff}`: a bare Date in
  // a raw sql`` template has no column encoder, and drizzle's postgres-js
  // driver makes the timestamptz serializer the identity, so postgres.js
  // would be handed the Date object and throw ERR_INVALID_ARG_TYPE.
  const deleted = await db
    .delete(s.tenants)
    .where(
      sql`${s.tenants.demoTemplateId} IS NOT NULL
          AND (${s.tenants.demoLastActiveAt} IS NULL OR ${s.tenants.demoLastActiveAt} < ${cutoff.toISOString()}::timestamptz)`,
    )
    .returning({ id: s.tenants.id });
  return deleted.length;
}

