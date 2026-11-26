// Notification Center — real-Postgres integration tests.
//
// Covers Phase N1:
//   • 3-level resolver (user → tenant override → system default)
//   • new producers (supplier.payment.recorded in both payment paths)
//   • tenant isolation across all three new tables
//   • audit-log side effect
//
// Every tenant-scoped read/write goes through withTenant so RLS is honoured;
// direct `db.*` on tenant-scoped tables returns zero rows even when they exist.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  activityLogs,
  employeeSchedules,
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
import { insertActivityRow } from "@/lib/repo/activity";
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

/** Count notification rows for a tenant+user inside withTenant so RLS doesn't
 *  hide the rows the dispatcher just inserted. */
async function countNotifications(tenantId: string, userId: string): Promise<number> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.tenantId, tenantId), eq(notifications.userId, userId))),
  );
  return Number(row?.c ?? 0);
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
    await withTenant(A.tenantId, (tx) =>
      tx.insert(tenantReportSettings).values({
        tenantId: A.tenantId,
        dailyEnabled: false,
        dailyHour: 7,
      }),
    );
    const [a] = await withTenant(A.tenantId, (tx) =>
      tx.select().from(tenantReportSettings).where(eq(tenantReportSettings.tenantId, A.tenantId)),
    );
    const [b] = await withTenant(B.tenantId, (tx) =>
      tx.select().from(tenantReportSettings).where(eq(tenantReportSettings.tenantId, B.tenantId)),
    );
    expect(a?.dailyEnabled).toBe(false);
    expect(a?.dailyHour).toBe(7);
    expect(b).toBeUndefined();
  });

  it("row persists for A after insert", async () => {
    const [row] = await withTenant(A.tenantId, (tx) =>
      tx
        .select({ tenantId: tenantReportSettings.tenantId })
        .from(tenantReportSettings)
        .where(eq(tenantReportSettings.tenantId, A.tenantId))
        .limit(1),
    );
    expect(row?.tenantId).toBe(A.tenantId);
  });
});

describe("tenant_notification_overrides — 3-level resolver", () => {
  const EVENT = "inventory.low_stock" as const;

  async function cleanBoth(): Promise<void> {
    await withTenant(A.tenantId, (tx) =>
      tx
        .delete(tenantNotificationOverrides)
        .where(
          and(
            eq(tenantNotificationOverrides.tenantId, A.tenantId),
            eq(tenantNotificationOverrides.eventType, EVENT),
          ),
        ),
    );
    await withTenant(A.tenantId, (tx) =>
      tx
        .delete(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.tenantId, A.tenantId),
            eq(notificationPreferences.userId, A.ownerId),
            eq(notificationPreferences.eventType, EVENT),
          ),
        ),
    );
    await withTenant(A.tenantId, (tx) =>
      tx
        .delete(notifications)
        .where(and(eq(notifications.tenantId, A.tenantId), eq(notifications.userId, A.ownerId))),
    );
  }

  it("with no user pref + no tenant override → system default applies (owner gets in-app)", async () => {
    await cleanBoth();

    await fanoutEvent(A.tenantId, null, EVENT, {
      productName: "Test",
      remainingQty: 1,
      threshold: 5,
    });

    expect(await countNotifications(A.tenantId, A.ownerId)).toBeGreaterThan(0);
  });

  it("with tenant override enabled=false → no in-app row created", async () => {
    await cleanBoth();
    await withTenant(A.tenantId, (tx) =>
      tx.insert(tenantNotificationOverrides).values({
        tenantId: A.tenantId,
        eventType: EVENT,
        enabled: false,
        updatedByUserId: A.ownerId,
      }),
    );

    await fanoutEvent(A.tenantId, null, EVENT, {
      productName: "Test2",
      remainingQty: 1,
      threshold: 5,
    });

    expect(await countNotifications(A.tenantId, A.ownerId)).toBe(0);
  });

  it("tenant override enabled=false BUT user pref inApp=true → user wins (gets the row)", async () => {
    await cleanBoth();
    await withTenant(A.tenantId, (tx) =>
      tx.insert(tenantNotificationOverrides).values({
        tenantId: A.tenantId,
        eventType: EVENT,
        enabled: false,
        updatedByUserId: A.ownerId,
      }),
    );
    await withTenant(A.tenantId, (tx) =>
      tx.insert(notificationPreferences).values({
        tenantId: A.tenantId,
        userId: A.ownerId,
        eventType: EVENT,
        inApp: true,
        push: true,
        email: false,
        digestMode: "instant",
      }),
    );

    await fanoutEvent(A.tenantId, null, EVENT, {
      productName: "Test3",
      remainingQty: 1,
      threshold: 5,
    });

    expect(await countNotifications(A.tenantId, A.ownerId)).toBeGreaterThan(0);
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

    await withTenant(A.tenantId, (tx) =>
      tx
        .delete(notifications)
        .where(and(eq(notifications.tenantId, A.tenantId), eq(notifications.userId, A.ownerId))),
    );

    await recordPayment(A.tenantId, poId, { amount: 500, method: "cash" });
    // Producer is void-fired post-TX — give the microtask + fanout ~200ms.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const [row] = await withTenant(A.tenantId, (tx) =>
      tx
        .select({ title: notifications.title })
        .from(notifications)
        .where(and(eq(notifications.tenantId, A.tenantId), eq(notifications.userId, A.ownerId)))
        .orderBy(sql`${notifications.createdAt} desc`)
        .limit(1),
    );
    expect(row?.title ?? "").toMatch(/حسين/);
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

    await withTenant(A.tenantId, (tx) =>
      tx
        .delete(notifications)
        .where(and(eq(notifications.tenantId, A.tenantId), eq(notifications.userId, A.ownerId))),
    );

    await recordSupplierAccountPayment(A.tenantId, supplierId, {
      amount: 2500,
      method: "cash",
      createdByUserId: A.ownerId,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const [row] = await withTenant(A.tenantId, (tx) =>
      tx
        .select({ title: notifications.title })
        .from(notifications)
        .where(and(eq(notifications.tenantId, A.tenantId), eq(notifications.userId, A.ownerId)))
        .orderBy(sql`${notifications.createdAt} desc`)
        .limit(1),
    );
    expect(row?.title ?? "").toMatch(/محمود/);
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

    const beforeB = await countNotifications(B.tenantId, B.ownerId);

    await recordSupplierAccountPayment(A.tenantId, supplierId, {
      amount: 100,
      method: "cash",
      createdByUserId: A.ownerId,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const afterB = await countNotifications(B.tenantId, B.ownerId);
    expect(afterB).toBe(beforeB);
  });
});

describe("Notification Center schema — accepts expected values", () => {
  it("employee_schedules: upsert round-trip", async () => {
    await withTenant(A.tenantId, (tx) =>
      tx.insert(employeeSchedules).values({
        tenantId: A.tenantId,
        userId: A.ownerId,
        shiftStart: "09:00:00",
        shiftEnd: "17:00:00",
      }),
    );
    const [row] = await withTenant(A.tenantId, (tx) =>
      tx
        .select()
        .from(employeeSchedules)
        .where(eq(employeeSchedules.tenantId, A.tenantId))
        .limit(1),
    );
    expect(row?.workDays).toBe(125);
    expect(row?.graceMinutes).toBe(-1);
    expect(row?.enabled).toBe(true);
    await withTenant(A.tenantId, (tx) =>
      tx
        .delete(employeeSchedules)
        .where(
          and(
            eq(employeeSchedules.tenantId, A.tenantId),
            eq(employeeSchedules.userId, A.ownerId),
          ),
        ),
    );
  });
});

describe("activity_logs — preference changes auditable", () => {
  it("insertActivityRow persists a preference change", async () => {
    // insertActivityRow is the synchronous path (logActivity enqueues).
    await insertActivityRow({
      tenantId: A.tenantId,
      actorUserId: A.ownerId,
      action: "notification.preference.changed",
      category: "settings",
      entityType: "tenant_notification_override",
      // entity_id is uuid — use tenant id as the stable handle; event type
      // moves into metadata.
      entityId: A.tenantId,
      metadata: { scope: "tenant", eventType: "inventory.low_stock", before: null, after: { enabled: false } },
    });
    const [row] = await withTenant(A.tenantId, (tx) =>
      tx
        .select({ action: activityLogs.action })
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.tenantId, A.tenantId),
            eq(activityLogs.action, "notification.preference.changed"),
          ),
        )
        .orderBy(sql`${activityLogs.createdAt} desc`)
        .limit(1),
    );
    expect(row?.action).toBe("notification.preference.changed");
  });
});
