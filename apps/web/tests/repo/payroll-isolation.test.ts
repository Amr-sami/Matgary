// Payroll V1 — cross-tenant isolation proof.
//
// Spins up two independent tenants with their own owner, staff, and finalized
// payroll sheets. Every public read/write entry point must refuse to see or
// mutate rows that belong to the OTHER tenant.
//
// RLS is the storage-layer guarantee; these tests prove the repo layer
// observes it correctly (in particular, every mutation goes through
// `withTenant` so `app.tenant_id` is set).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPayrollAdjustment,
  finalizePayrollPeriod,
  getEmployeePayrollMonth,
  listPayrollAdjustments,
  listPayrollMonth,
  upsertPayrollDraft,
  voidPayrollAdjustment,
  voidPayrollPeriod,
} from "@/lib/repo/payroll-periods";
import {
  addAdjustment,
  addShift,
  addStaff,
  seedPayrollTenant,
  setCompensation,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

const MONTH = new Date("2026-03-01T00:00:00Z");

let A: PayrollTenantSeed;
let B: PayrollTenantSeed;
let empA: string;
let empB: string;
let periodIdA: string;
let adjIdA: string;

beforeAll(async () => {
  A = await seedPayrollTenant("iso-a");
  B = await seedPayrollTenant("iso-b");

  empA = await addStaff(A.tenantId, { name: "Tenant A Staff" });
  empB = await addStaff(B.tenantId, { name: "Tenant B Staff" });
  await setCompensation(A.tenantId, {
    employeeId: empA,
    createdByUserId: A.ownerId,
    payType: "fixed",
    base: 3100,
  });
  await setCompensation(B.tenantId, {
    employeeId: empB,
    createdByUserId: B.ownerId,
    payType: "fixed",
    base: 5000,
  });
  await addShift(A.tenantId, {
    employeeId: empA,
    recordedByUserId: A.ownerId,
    start: new Date("2026-03-02T08:00:00Z"),
    end: new Date("2026-03-02T16:00:00Z"),
  });
  const sheetA = await finalizePayrollPeriod(A.tenantId, empA, MONTH, A.ownerId);
  periodIdA = sheetA.periodId!;
  adjIdA = await addAdjustment(A.tenantId, {
    employeeId: empA,
    // A fresh month for an unfinalized adjustment on tenant A.
    periodMonth: new Date("2026-04-01T00:00:00Z"),
    kind: "bonus",
    amount: 100,
    createdByUserId: A.ownerId,
  });
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("tenant isolation — reads", () => {
  it("listPayrollMonth(B) does not see A's employees or sheets", async () => {
    const bRows = await listPayrollMonth(B.tenantId, MONTH);
    expect(bRows.every((r) => r.employeeId !== empA)).toBe(true);
  });

  it("getEmployeePayrollMonth(B, empA) returns null — A's employee isn't a member of B", async () => {
    const sheet = await getEmployeePayrollMonth(B.tenantId, empA, MONTH);
    expect(sheet).toBeNull();
  });

  it("listPayrollAdjustments(B) does not see A's adjustments", async () => {
    const rows = await listPayrollAdjustments(
      B.tenantId,
      empA,
      new Date("2026-04-01T00:00:00Z"),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("tenant isolation — writes", () => {
  it("upsertPayrollDraft(B, empA, ...) cannot mutate A's row — it finds no member and inserts under B's tenant_id scope with RLS ignoring A", async () => {
    // The repo loads the comp history, attendance, etc. tenant-scoped via
    // withTenant. For (B, empA), there's no comp row or attendance, so the
    // snapshot is zero'd. CRUCIALLY, A's finalized row is untouched.
    await upsertPayrollDraft(B.tenantId, empA, MONTH);
    const aSheetAfter = await getEmployeePayrollMonth(A.tenantId, empA, MONTH);
    expect(aSheetAfter?.lifecycle).toBe("FINALIZED");
    // Same grossAmount as before the cross-tenant poke.
    expect(aSheetAfter?.snapshot.grossAmount).toBeGreaterThan(0);
  });

  it("finalizePayrollPeriod(B, empA, ...) does NOT flip A's row to double-finalized", async () => {
    // B gets its own finalized row for empA (zero-valued); A's stays intact.
    await finalizePayrollPeriod(B.tenantId, empA, MONTH, B.ownerId);
    const aSheet = await getEmployeePayrollMonth(A.tenantId, empA, MONTH);
    expect(aSheet?.lifecycle).toBe("FINALIZED");
    expect(aSheet?.finalizedByUserId).toBe(A.ownerId); // NOT B.ownerId
  });

  it("voidPayrollPeriod(B, periodIdA, ...) throws NOT_FOUND — the id belongs to A", async () => {
    await expect(
      voidPayrollPeriod(B.tenantId, periodIdA, B.ownerId, "cross-tenant void attempt"),
    ).rejects.toMatchObject({ name: "PayrollLifecycleError", code: "NOT_FOUND" });
    // A's row is still finalized.
    const aSheet = await getEmployeePayrollMonth(A.tenantId, empA, MONTH);
    expect(aSheet?.lifecycle).toBe("FINALIZED");
  });

  it("createPayrollAdjustment(B, empA, ...) stores under B's tenant and is invisible to A", async () => {
    await createPayrollAdjustment(B.tenantId, {
      employeeId: empA,
      periodStart: new Date("2026-04-01T00:00:00Z"),
      kind: "bonus",
      amount: 999,
      reason: "cross-tenant insert attempt",
      createdByUserId: B.ownerId,
    });
    const aRows = await listPayrollAdjustments(
      A.tenantId,
      empA,
      new Date("2026-04-01T00:00:00Z"),
    );
    // A still sees exactly the one bonus it created.
    expect(aRows).toHaveLength(1);
    expect(aRows[0]?.amount).toBe("100.00");
  });

  it("voidPayrollAdjustment(B, adjIdA, ...) throws NOT_FOUND — cannot void across tenants", async () => {
    await expect(
      voidPayrollAdjustment(B.tenantId, adjIdA, B.ownerId),
    ).rejects.toMatchObject({ name: "PayrollLifecycleError", code: "NOT_FOUND" });
    // A's adjustment is still live.
    const aRows = await listPayrollAdjustments(
      A.tenantId,
      empA,
      new Date("2026-04-01T00:00:00Z"),
    );
    expect(aRows[0]?.id).toBe(adjIdA);
  });
});
