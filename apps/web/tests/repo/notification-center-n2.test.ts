// Notification Center — N2 attendance late-arrival sweep.
//
// Each case plants a schedule + attendance state + tenant tz, invokes the
// cron handler directly (bypasses cron auth), and asserts what the
// dispatcher wrote.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  attendanceEvents,
  attendanceSettings,
  employeeSchedules,
  leaveRequests,
  notifications,
  tenantMembers,
  tenants,
} from "@/lib/db/schema";
import { runAttendanceLateSweep } from "@/app/api/cron/attendance-late-sweep/route";
import {
  addStaff,
  seedPayrollTenant,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

/** Call the sweep's pure function directly — bypasses the cron rate limit
 *  that's keyed on IP and would otherwise cap this test file at 6 calls/hour. */
async function callLateSweep() {
  return runAttendanceLateSweep();
}

async function countLateNotifications(tenantId: string, ownerId: string): Promise<number> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.userId, ownerId),
          sql`${notifications.link} like '%late=1%'`,
        ),
      ),
  );
  return Number(row?.c ?? 0);
}

async function clearLateNotifications(tenantId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx
      .delete(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          sql`${notifications.link} like '%late=1%'`,
        ),
      ),
  );
}

async function setTenantTimezone(tenantId: string, tz: string): Promise<void> {
  await db.update(tenants).set({ timezone: tz }).where(eq(tenants.id, tenantId));
}

async function putSchedule(
  seed: PayrollTenantSeed,
  userId: string,
  shiftStart: string,
  args: { workDays?: number; graceMinutes?: number; enabled?: boolean } = {},
): Promise<void> {
  await withTenant(seed.tenantId, (tx) =>
    tx
      .delete(employeeSchedules)
      .where(
        and(
          eq(employeeSchedules.tenantId, seed.tenantId),
          eq(employeeSchedules.userId, userId),
        ),
      ),
  );
  await withTenant(seed.tenantId, (tx) =>
    tx.insert(employeeSchedules).values({
      tenantId: seed.tenantId,
      userId,
      shiftStart,
      shiftEnd: "17:00:00",
      workDays: args.workDays ?? 127, // every day on by default for the test
      graceMinutes: args.graceMinutes ?? 0,
      enabled: args.enabled ?? true,
    }),
  );
}

async function ensureAttendanceSettings(seed: PayrollTenantSeed, grace: number): Promise<void> {
  const [row] = await withTenant(seed.tenantId, (tx) =>
    tx
      .select({ tenantId: attendanceSettings.tenantId })
      .from(attendanceSettings)
      .where(eq(attendanceSettings.tenantId, seed.tenantId))
      .limit(1),
  );
  if (row) {
    await withTenant(seed.tenantId, (tx) =>
      tx
        .update(attendanceSettings)
        .set({ graceMinutesLate: grace })
        .where(eq(attendanceSettings.tenantId, seed.tenantId)),
    );
  } else {
    await withTenant(seed.tenantId, (tx) =>
      tx.insert(attendanceSettings).values({
        tenantId: seed.tenantId,
        graceMinutesLate: grace,
      }),
    );
  }
}

async function recordCheckIn(seed: PayrollTenantSeed, userId: string, at: Date): Promise<void> {
  await withTenant(seed.tenantId, (tx) =>
    tx.insert(attendanceEvents).values({
      tenantId: seed.tenantId,
      employeeId: userId,
      type: "check_in",
      occurredAt: at,
      source: "manual",
      recordedByUserId: userId,
    }),
  );
}

let A: PayrollTenantSeed;
let B: PayrollTenantSeed;
let staffUserA: string;

beforeAll(async () => {
  A = await seedPayrollTenant("nc-late-a");
  B = await seedPayrollTenant("nc-late-b");
  staffUserA = await addStaff(A.tenantId, { name: "Hussein" });
  await ensureAttendanceSettings(A, 0);
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

/** Current UTC hour + minute as "HH:MM". Useful for building shift times
 *  that the sweep sees as "already past the threshold". */
function nowUtcHHMM(offsetMin = 0): string {
  const d = new Date(Date.now() + offsetMin * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:00`;
}

describe("attendance.late sweep", () => {
  it("disabled schedule → no fanout", async () => {
    await clearLateNotifications(A.tenantId);
    await setTenantTimezone(A.tenantId, "UTC");
    // Schedule says shift already started 1h ago with 0 grace, BUT enabled=false
    await putSchedule(A, staffUserA, nowUtcHHMM(-60), { enabled: false });
    await callLateSweep();
    expect(await countLateNotifications(A.tenantId, A.ownerId)).toBe(0);
  });

  it("non-workday → skip (no fanout)", async () => {
    await clearLateNotifications(A.tenantId);
    await setTenantTimezone(A.tenantId, "UTC");
    const now = new Date();
    const todayDow = now.getUTCDay(); // 0..6
    const workMaskWithoutToday = 127 & ~(1 << todayDow);
    await putSchedule(A, staffUserA, nowUtcHHMM(-60), {
      workDays: workMaskWithoutToday,
      graceMinutes: 0,
    });
    await callLateSweep();
    expect(await countLateNotifications(A.tenantId, A.ownerId)).toBe(0);
  });

  it("approved leave covering today → skip", async () => {
    await clearLateNotifications(A.tenantId);
    await setTenantTimezone(A.tenantId, "UTC");
    await putSchedule(A, staffUserA, nowUtcHHMM(-60), { graceMinutes: 0 });
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    await withTenant(A.tenantId, (tx) =>
      tx.insert(leaveRequests).values({
        tenantId: A.tenantId,
        branchId: A.branchId,
        userId: staffUserA,
        startDate: today,
        endDate: tomorrow,
        status: "approved",
        kind: "paid",
      }),
    );
    try {
      await callLateSweep();
      expect(await countLateNotifications(A.tenantId, A.ownerId)).toBe(0);
    } finally {
      await withTenant(A.tenantId, (tx) =>
        tx
          .delete(leaveRequests)
          .where(
            and(eq(leaveRequests.tenantId, A.tenantId), eq(leaveRequests.userId, staffUserA)),
          ),
      );
    }
  });

  it("grace not yet expired → not late (no fanout)", async () => {
    await clearLateNotifications(A.tenantId);
    await setTenantTimezone(A.tenantId, "UTC");
    // Shift starts in 10 min, grace 30 → threshold is 40 min from now.
    await putSchedule(A, staffUserA, nowUtcHHMM(10), { graceMinutes: 30 });
    await callLateSweep();
    expect(await countLateNotifications(A.tenantId, A.ownerId)).toBe(0);
  });

  it("no check-in + grace expired → fires attendance.late", async () => {
    await clearLateNotifications(A.tenantId);
    await setTenantTimezone(A.tenantId, "UTC");
    // Shift started 30 min ago; grace 0 → late by 30 min.
    await putSchedule(A, staffUserA, nowUtcHHMM(-30), { graceMinutes: 0 });
    await callLateSweep();
    expect(await countLateNotifications(A.tenantId, A.ownerId)).toBeGreaterThan(0);
  });

  it("second sweep same day → deduped (no second row)", async () => {
    // State from previous test: schedule still late. Sweep should dedupe.
    const before = await countLateNotifications(A.tenantId, A.ownerId);
    await callLateSweep();
    const after = await countLateNotifications(A.tenantId, A.ownerId);
    expect(after).toBe(before);
  });

  it("on-time check-in → not late (no fanout)", async () => {
    await clearLateNotifications(A.tenantId);
    await setTenantTimezone(A.tenantId, "UTC");
    const now = new Date();
    // Shift started 60 min ago; employee checked in 10 min after (within grace of 30).
    await putSchedule(A, staffUserA, nowUtcHHMM(-60), { graceMinutes: 30 });
    const checkInAt = new Date(now.getTime() - 50 * 60 * 1000);
    await recordCheckIn(A, staffUserA, checkInAt);
    try {
      await callLateSweep();
      expect(await countLateNotifications(A.tenantId, A.ownerId)).toBe(0);
    } finally {
      await withTenant(A.tenantId, (tx) =>
        tx
          .delete(attendanceEvents)
          .where(
            and(
              eq(attendanceEvents.tenantId, A.tenantId),
              eq(attendanceEvents.employeeId, staffUserA),
            ),
          ),
      );
    }
  });

  it("late check-in (after threshold) → fires attendance.late", async () => {
    await clearLateNotifications(A.tenantId);
    await setTenantTimezone(A.tenantId, "UTC");
    const now = new Date();
    // Shift 60 min ago, grace 5 (threshold = shift_start + 5 min).
    // Checked in 40 min after shift → clearly past threshold.
    await putSchedule(A, staffUserA, nowUtcHHMM(-60), { graceMinutes: 5 });
    const checkInAt = new Date(now.getTime() - 20 * 60 * 1000); // 40 min after shift start
    await recordCheckIn(A, staffUserA, checkInAt);
    try {
      await callLateSweep();
      expect(await countLateNotifications(A.tenantId, A.ownerId)).toBeGreaterThan(0);
    } finally {
      await withTenant(A.tenantId, (tx) =>
        tx
          .delete(attendanceEvents)
          .where(
            and(
              eq(attendanceEvents.tenantId, A.tenantId),
              eq(attendanceEvents.employeeId, staffUserA),
            ),
          ),
      );
    }
  });

  it("cross-tenant: A's late doesn't fire in B", async () => {
    await clearLateNotifications(A.tenantId);
    await clearLateNotifications(B.tenantId);
    await setTenantTimezone(A.tenantId, "UTC");
    await setTenantTimezone(B.tenantId, "UTC");
    await putSchedule(A, staffUserA, nowUtcHHMM(-30), { graceMinutes: 0 });
    // B has no schedule rows; nothing should fire for B.
    await callLateSweep();
    expect(await countLateNotifications(B.tenantId, B.ownerId)).toBe(0);
  });
});
