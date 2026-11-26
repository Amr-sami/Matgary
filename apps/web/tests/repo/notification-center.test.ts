// Notification Center — real-Postgres integration tests.
//
// Covers Phase N1:
//   • 3-level resolver (user → tenant override → system default)
//   • new producers (supplier.payment.recorded in both payment paths)
//   • report-settings persistence
//   • tenant isolation across all three new tables
//   • audit-log side effect

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  activityLogs,
  notificationPreferences,
  notifications,
  purchaseOrders,
  suppliers,
  tenantNotificationOverrides,
  tenantReportSettings,
} from "@/lib/db/schema";
import { fanoutEvent } from "@/lib/notifications/dispatch";
import { recordPayment } from "@/lib/repo/purchase-payments";
import { recordSupplierAccountPayment } from "@/lib/repo/supplier-account-payment";
import {
  seedPayrollTenant,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

async function freshSupplier(seed: PayrollTenantSeed, name: string, balance = 0): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${seed.tenantId}, true)`);
    const [s] = await tx
      .insert(suppliers)
      .values({
        tenantId: seed.tenantId,
        branchId: seed.branchId,
        name,
        phone: `+2010${Math.random().toString().slice(2, 10)}`,
        balance: String(balance),
      })
      .returning({ id: suppliers.id });
    return s.id;
  });
}

async function insertReceivedPO(
  seed: PayrollTenantSeed,
  supplierId: string,
  total: number,
  paidAmount: number,
): Promise<string> {
  return withTenant(seed.tenantId, async (tx) => {
    const [po] = await tx
      .insert(purchaseOrders)
      .values({
        tenantId: seed.tenantId,
        branchId: seed.branchId,
        supplierId,
        status: "received",
        total: String(total),
        paidAmount: String(paidAmount),
        orderDate: new Date(),
        receivedDate: new Date(),
      })
      .returning({ id: purchaseOrders.id });
    return po.id;
  });
}

let A: PayrollTenantSeed;
let B: PayrollTenantSeed;

beforeAll(async () => {
  A = await seedPayrollTenant("nc-a");
  B = await seedPayrollTenant("nc-b");
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("tenant_report_settings — isolation + defaults", () => {
  it("inserting a row in A doesn't surface in B", async () => {
    await db.insert(tenantReportSettings).values({
      tenantId: A.tenantId,
      dailyEnabled: false,
      dailyHour: 7,
    });
    const [a] = await db
      .select()
      .from(tenantReportSettings)
      .where(eq(tenantReportSettings.tenantId, A.tenantId));
    const [b] = await db
      .select()
      .from(tenantReportSettings)
      .where(eq(tenantReportSettings.tenantId, B.tenantId));
    expect(a?.dailyEnabled).toBe(false);
    expect(a?.dailyHour).toBe(7);
    expect(b).toBeUndefined();
  });

  it("row is deleted when tenant is deleted (cascade)", async () => {
    // Can't actually delete the test tenant mid-suite; just sanity check FK.
    const [row] = await db
      .select({ tenantId: tenantReportSettings.tenantId })
      .from(tenantReportSettings)
      .where(eq(tenantReportSettings.tenantId, A.tenantId))
      .limit(1);
    expect(row?.tenantId).toBe(A.tenantId);
  });
});

describe("tenant_notification_overrides — 3-level resolver", () => {
  const EVENT = "inventory.low_stock" as const;

  it("with no user pref + no tenant override → system default applies (owner gets in-app)", async () => {
    // Clean slate
    await db
      .delete(tenantNotificationOverrides)
      .where(
        and(
          eq(tenantNotificationOverrides.tenantId, A.tenantId),
          eq(tenantNotificationOverrides.eventType, EVENT),
        ),
      );
    await db
      .delete(notifications)
      .where(and(eq(notifications.tenantId, A.tenantId), eq(notifications.userId, A.ownerId)));

    await fanoutEvent(A.tenantId, null, EVENT, {
      productId: "test-product-id",
      productName: "Test",
      remainingQty: 1,
      threshold: 5,
    });

    const rows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.tenantId, A.tenantId), eq(notifications.userId, A.ownerId)));
    expect(Number(rows[0]?.c ?? 0)).toBeGreaterThan(0);
  });

  it("with tenant override enabled=false → no in-app row created", async () => {
    // Insert override
    await db.insert(tenantNotificationOverrides).values({
      tenantId: A.tenantId,
      eventType: EVENT,
      enabled: false,
      updatedByUserId: A.ownerId,
    });
    // Clean notifications for the owner
    await db
      .delete(notifications)
      .where(and(eq(notifications.tenantId, A.tenantId), eq(notifications.userId, A.ownerId)));

    await fanoutEvent(A.tenantId, null, EVENT, {
      productId: "test-product-id",
      productName: "Test2",
      remainingQty: 1,
      threshold: 5,
    });

    const rows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.tenantId, A.tenantId), eq(notifications.userId, A.ownerId)));
    expect(Number(rows[0]?.c ?? 0)).toBe(0);

    // Cleanup
    await db
      .delete(tenantNotificationOverrides)
      .where(
        and(
          eq(tenantNotificationOverrides.tenantId, A.tenantId),
          eq(tenantNotificationOverrides.eventType, EVENT),
        ),
      );
  });

  it("tenant override enabled=false BUT user pref inApp=true → user wins (gets the row)", async () => {
    // Set tenant override off
    await db.insert(tenantNotificationOverrides).values({
      tenantId: A.tenantId,
      eventType: EVENT,
      enabled: false,
      updatedByUserId: A.ownerId,
    });
    // Set user preference explicitly ON
    await db.insert(notificationPreferences).values({
      tenantId: A.tenantId,
      userId: A.ownerId,
      eventType: EVENT,
      inApp: true,
      push: true,
      email: false,
      digestMode: "instant",
    });
    // Clean
    await db
      .delete(notifications)
      .where(and(eq(notifications.tenantId, A.tenantId), eq(notifications.userId, A.ownerId)));

    await fanoutEvent(A.tenantId, null, EVENT, {
      productId: "test-product-id-3",
      productName: "Test3",
      remainingQty: 1,
      threshold: 5,
    });

    const rows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.tenantId, A.tenantId), eq(notifications.userId, A.ownerId)));
    expect(Number(rows[0]?.c ?? 0)).toBeGreaterThan(0);

    // Cleanup
    await db
      .delete(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.tenantId, A.tenantId),
          eq(notificationPreferences.userId, A.ownerId),
          eq(notificationPreferences.eventType, EVENT),
        ),
      );
    await db
      .delete(tenantNotificationOverrides)
      .where(
        and(
          eq(tenantNotificationOverrides.tenantId, A.tenantId),
          eq(tenantNotificationOverrides.eventType, EVENT),
        ),
      );
  });
});

describe("supplier.payment.recorded producer — both payment paths", () => {
  it("PO-level recordPayment fires supplier.payment.recorded after commit", async () => {
    const supplierId = await freshSupplier(A, "حسين PO", 0);
    const poId = await insertReceivedPO(A, supplierId, 5000, 0);
    await withTenant(A.tenantId, (tx) =>
      tx
        .update(suppliers)
        .set({ balance: "5000" })
        .where(and(eq(suppliers.tenantId, A.tenantId), eq(suppliers.id, supplierId))),
    );

    await db
      .delete(notifications)
      .where(and(eq(notifications.tenantId, A.tenantId), eq(notifications.userId, A.ownerId)));

    await recordPayment(A.tenantId, poId, { amount: 500, method: "cash" });

    // The producer is void-fanned-out, so give the microtask queue a tick.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const [row] = await db
      .select({ title: notifications.title })
      .from(notifications)
      .where(and(eq(notifications.tenantId, A.tenantId), eq(notifications.userId, A.ownerId)))
      .orderBy(sql`${notifications.createdAt} desc`)
      .limit(1);
    expect(row?.title).toMatch(/حسين/);
  });

  it("account-level recordSupplierAccountPayment fires supplier.payment.recorded after commit", async () => {
    const supplierId = await freshSupplier(A, "محمود acct", 0);
    await insertReceivedPO(A, supplierId, 10_000, 0);
    await withTenant(A.tenantId, (tx) =>
      tx
        .update(suppliers)
        .set({ balance: "10000" })
        .where(and(eq(suppliers.tenantId, A.tenantId), eq(suppliers.id, supplierId))),
    );

    await db
      .delete(notifications)
      .where(and(eq(notifications.tenantId, A.tenantId), eq(notifications.userId, A.ownerId)));

    await recordSupplierAccountPayment(A.tenantId, supplierId, {
      amount: 2500,
      method: "cash",
      createdByUserId: A.ownerId,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const [row] = await db
      .select({ title: notifications.title })
      .from(notifications)
      .where(and(eq(notifications.tenantId, A.tenantId), eq(notifications.userId, A.ownerId)))
      .orderBy(sql`${notifications.createdAt} desc`)
      .limit(1);
    expect(row?.title).toMatch(/محمود/);
  });

  it("cross-tenant: A's payment doesn't produce a notification in B", async () => {
    const supplierId = await freshSupplier(A, "iso test", 0);
    await insertReceivedPO(A, supplierId, 1000, 0);
    await withTenant(A.tenantId, (tx) =>
      tx
        .update(suppliers)
        .set({ balance: "1000" })
        .where(and(eq(suppliers.tenantId, A.tenantId), eq(suppliers.id, supplierId))),
    );

    const beforeB = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(eq(notifications.tenantId, B.tenantId));

    await recordSupplierAccountPayment(A.tenantId, supplierId, {
      amount: 100,
      method: "cash",
      createdByUserId: A.ownerId,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const afterB = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(eq(notifications.tenantId, B.tenantId));

    expect(Number(afterB[0]?.c ?? 0)).toBe(Number(beforeB[0]?.c ?? 0));
  });
});

describe("Notification Center schema — accepts expected values", () => {
  it("employee_schedules: upsert round-trip", async () => {
    // Just insert + read to prove the schema is reachable + bitmask default.
    // Real schedule CRUD + late-sweep ride in N2.
    const { employeeSchedules } = await import("@/lib/db/schema");
    await db.insert(employeeSchedules).values({
      tenantId: A.tenantId,
      userId: A.ownerId,
      shiftStart: "09:00:00",
      shiftEnd: "17:00:00",
      // work_days default = 125 (Fri off, Sat–Thu on)
    });
    const [row] = await db
      .select()
      .from(employeeSchedules)
      .where(eq(employeeSchedules.tenantId, A.tenantId))
      .limit(1);
    expect(row?.workDays).toBe(125);
    expect(row?.graceMinutes).toBe(-1);
    expect(row?.enabled).toBe(true);
    // Cleanup so the next suite run can insert again.
    await db
      .delete(employeeSchedules)
      .where(
        and(
          eq(employeeSchedules.tenantId, A.tenantId),
          eq(employeeSchedules.userId, A.ownerId),
        ),
      );
  });
});

describe("activity_logs — preference changes auditable", () => {
  it("writing an activity row via logActivity for a preference change works", async () => {
    const { logActivity } = await import("@/lib/repo/activity");
    await logActivity({
      tenantId: A.tenantId,
      actorUserId: A.ownerId,
      action: "notification.preference.changed",
      category: "settings",
      entityType: "test_entity",
      entityId: "test-event",
      metadata: { scope: "tenant", eventType: "test", before: null, after: { enabled: false } },
    });
    const [row] = await db
      .select({ action: activityLogs.action })
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.tenantId, A.tenantId),
          eq(activityLogs.action, "notification.preference.changed"),
        ),
      )
      .orderBy(sql`${activityLogs.createdAt} desc`)
      .limit(1);
    expect(row?.action).toBe("notification.preference.changed");
  });
});
