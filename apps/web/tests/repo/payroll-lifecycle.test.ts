// Payroll V1 — lifecycle integration tests against real Postgres.
//
// Proves the MISSING → DRAFT → FINALIZED → VOIDED state machine the
// repo layer in lib/repo/payroll-periods.ts promises, including idempotency
// of calculate + finalize, and that voiding unblocks a fresh draft/finalize
// for the SAME month (partial unique on `status <> voided`).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PayrollLifecycleError,
  finalizePayrollPeriod,
  getEmployeePayrollMonth,
  upsertPayrollDraft,
  voidPayrollPeriod,
} from "@/lib/repo/payroll-periods";
import {
  addShift,
  seedPayrollTenant,
  setCompensation,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

let seed: PayrollTenantSeed;
let employeeId: string;
const MONTH = new Date("2026-03-01T00:00:00Z");

beforeAll(async () => {
  seed = await seedPayrollTenant("lifecycle");
  // Owner is self; make the owner the employee being paid — simpler for lifecycle test.
  employeeId = seed.ownerId;
  await setCompensation(seed.tenantId, {
    employeeId,
    createdByUserId: seed.ownerId,
    payType: "fixed",
    base: 3100,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  });
  // Give the employee one 8-hour shift so attendance isn't entirely empty.
  await addShift(seed.tenantId, {
    employeeId,
    recordedByUserId: seed.ownerId,
    start: new Date("2026-03-02T08:00:00Z"),
    end: new Date("2026-03-02T16:00:00Z"),
  });
});

afterAll(async () => {
  await seed.cleanup();
});

describe("payroll lifecycle", () => {
  it("MISSING → DRAFT when upsertPayrollDraft is called", async () => {
    const before = await getEmployeePayrollMonth(seed.tenantId, employeeId, MONTH);
    expect(before?.lifecycle).toBe("MISSING");
    expect(before?.periodId).toBeNull();

    const sheet = await upsertPayrollDraft(seed.tenantId, employeeId, MONTH);
    expect(sheet.lifecycle).toBe("DRAFT");
    expect(sheet.periodId).toBeTruthy();
    expect(sheet.snapshot.grossAmount).toBeGreaterThan(0);

    const again = await getEmployeePayrollMonth(seed.tenantId, employeeId, MONTH);
    expect(again?.lifecycle).toBe("DRAFT");
    expect(again?.periodId).toBe(sheet.periodId);
  });

  it("calling upsertPayrollDraft twice is idempotent (same row, same snapshot)", async () => {
    const first = await upsertPayrollDraft(seed.tenantId, employeeId, MONTH);
    const second = await upsertPayrollDraft(seed.tenantId, employeeId, MONTH);
    expect(second.periodId).toBe(first.periodId);
    expect(second.snapshot.grossAmount).toBe(first.snapshot.grossAmount);
    expect(second.snapshot.netAmount).toBe(first.snapshot.netAmount);
  });

  it("DRAFT → FINALIZED freezes the snapshot and stamps finalizedBy/At", async () => {
    const sheet = await finalizePayrollPeriod(
      seed.tenantId,
      employeeId,
      MONTH,
      seed.ownerId,
    );
    expect(sheet.lifecycle).toBe("FINALIZED");
    expect(sheet.finalizedAt).toBeTruthy();
    expect(sheet.finalizedByUserId).toBe(seed.ownerId);
    expect(sheet.compensationSnapshot?.baseSalaryMonthly).toBe(3100);
  });

  it("re-finalizing a finalized period throws ALREADY_FINALIZED", async () => {
    await expect(
      finalizePayrollPeriod(seed.tenantId, employeeId, MONTH, seed.ownerId),
    ).rejects.toMatchObject({ name: "PayrollLifecycleError", code: "ALREADY_FINALIZED" });
  });

  it("recalculating a finalized period throws ALREADY_FINALIZED", async () => {
    await expect(
      upsertPayrollDraft(seed.tenantId, employeeId, MONTH),
    ).rejects.toBeInstanceOf(PayrollLifecycleError);
  });

  it("FINALIZED → VOIDED sets status=voided + voidedAt/By/Reason", async () => {
    const existing = await getEmployeePayrollMonth(seed.tenantId, employeeId, MONTH);
    expect(existing?.periodId).toBeTruthy();
    const voided = await voidPayrollPeriod(
      seed.tenantId,
      existing!.periodId!,
      seed.ownerId,
      "test: redo for a fresh month",
    );
    expect(voided.status).toBe("voided");
    expect(voided.voidedAt).toBeTruthy();
    expect(voided.voidedByUserId).toBe(seed.ownerId);
    expect(voided.voidReason).toBe("test: redo for a fresh month");
  });

  it("voided period lets a new DRAFT be created for the same month", async () => {
    // getEmployeePayrollMonth filters status <> voided, so it should now
    // report MISSING — the voided row is excluded from the live view.
    const after = await getEmployeePayrollMonth(seed.tenantId, employeeId, MONTH);
    expect(after?.lifecycle).toBe("MISSING");

    const next = await upsertPayrollDraft(seed.tenantId, employeeId, MONTH);
    expect(next.lifecycle).toBe("DRAFT");
    expect(next.periodId).toBeTruthy();
  });

  it("the new draft can be finalized again (full redo cycle completes)", async () => {
    const refinalized = await finalizePayrollPeriod(
      seed.tenantId,
      employeeId,
      MONTH,
      seed.ownerId,
    );
    expect(refinalized.lifecycle).toBe("FINALIZED");
  });

  it("voidPayrollPeriod on a DRAFT throws NOT_FINALIZED", async () => {
    // Spin up a brand new month (April) in DRAFT only, try to void it.
    const APRIL = new Date("2026-04-01T00:00:00Z");
    const draft = await upsertPayrollDraft(seed.tenantId, employeeId, APRIL);
    await expect(
      voidPayrollPeriod(seed.tenantId, draft.periodId!, seed.ownerId, null),
    ).rejects.toMatchObject({ name: "PayrollLifecycleError", code: "NOT_FINALIZED" });
  });

  it("voidPayrollPeriod on a non-existent id throws NOT_FOUND", async () => {
    await expect(
      voidPayrollPeriod(
        seed.tenantId,
        "00000000-0000-4000-8000-000000000000",
        seed.ownerId,
        null,
      ),
    ).rejects.toMatchObject({ name: "PayrollLifecycleError", code: "NOT_FOUND" });
  });
});
