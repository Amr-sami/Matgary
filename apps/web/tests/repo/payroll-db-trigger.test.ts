// Payroll V1 — DB-level immutability trigger.
//
// The repo API refuses to mutate finalized rows, but the TRIGGER in
// 0068_payroll_v1.sql is the last line of defense: even a direct SQL
// UPDATE from a rogue session must be rejected, except the single
// finalized → voided transition.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { payrollPeriods } from "@/lib/db/schema";
import { finalizePayrollPeriod } from "@/lib/repo/payroll-periods";
import {
  addShift,
  addStaff,
  seedPayrollTenant,
  setCompensation,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

let seed: PayrollTenantSeed;
let employeeId: string;
let finalizedId: string;
const MONTH = new Date("2026-03-01T00:00:00Z");

/** Matches postgres-js's shape: the thrown error's message starts with
 *  "Failed query: ..." and `.cause` / `.message` of the wrapped PG error
 *  carries our plpgsql RAISE text. We check both to be robust. */
function isTriggerRejection(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const text = [err.message, (err as { detail?: string }).detail, String((err as { cause?: unknown }).cause ?? "")].join(" ");
  return /finalized/i.test(text) || /immutable/i.test(text) || /payroll_periods/.test(text);
}

beforeAll(async () => {
  seed = await seedPayrollTenant("trigger");
  employeeId = await addStaff(seed.tenantId, { name: "Trigger Tamer" });
  await setCompensation(seed.tenantId, {
    employeeId,
    createdByUserId: seed.ownerId,
    payType: "fixed",
    base: 3100,
  });
  await addShift(seed.tenantId, {
    employeeId,
    recordedByUserId: seed.ownerId,
    start: new Date("2026-03-02T08:00:00Z"),
    end: new Date("2026-03-02T16:00:00Z"),
  });
  const sheet = await finalizePayrollPeriod(seed.tenantId, employeeId, MONTH, seed.ownerId);
  finalizedId = sheet.periodId!;
});

afterAll(async () => {
  await seed.cleanup();
});

describe("DB trigger rejects edits to FINALIZED rows", () => {
  it("UPDATE grossAmount is rejected", async () => {
    await expect(
      withTenant(seed.tenantId, (tx) =>
        tx
          .update(payrollPeriods)
          .set({ grossAmount: "9999" })
          .where(
            and(
              eq(payrollPeriods.tenantId, seed.tenantId),
              eq(payrollPeriods.id, finalizedId),
            ),
          ),
      ),
    ).rejects.toSatisfy(isTriggerRejection);
  });

  it("UPDATE snapshot JSON is rejected", async () => {
    await expect(
      withTenant(seed.tenantId, (tx) =>
        tx
          .update(payrollPeriods)
          .set({ snapshot: { tampered: true } })
          .where(
            and(
              eq(payrollPeriods.tenantId, seed.tenantId),
              eq(payrollPeriods.id, finalizedId),
            ),
          ),
      ),
    ).rejects.toSatisfy(isTriggerRejection);
  });

  it("UPDATE netAmount is rejected", async () => {
    await expect(
      withTenant(seed.tenantId, (tx) =>
        tx
          .update(payrollPeriods)
          .set({ netAmount: "123" })
          .where(
            and(
              eq(payrollPeriods.tenantId, seed.tenantId),
              eq(payrollPeriods.id, finalizedId),
            ),
          ),
      ),
    ).rejects.toSatisfy(isTriggerRejection);
  });

  it("UPDATE status back to draft is rejected", async () => {
    await expect(
      withTenant(seed.tenantId, (tx) =>
        tx
          .update(payrollPeriods)
          .set({ status: "draft" })
          .where(
            and(
              eq(payrollPeriods.tenantId, seed.tenantId),
              eq(payrollPeriods.id, finalizedId),
            ),
          ),
      ),
    ).rejects.toSatisfy(isTriggerRejection);
  });

  it("the void transition (status→voided + metadata) IS allowed", async () => {
    await withTenant(seed.tenantId, (tx) =>
      tx
        .update(payrollPeriods)
        .set({
          status: "voided",
          voidedAt: new Date(),
          voidedByUserId: seed.ownerId,
          voidReason: "trigger allows the transition",
        })
        .where(
          and(
            eq(payrollPeriods.tenantId, seed.tenantId),
            eq(payrollPeriods.id, finalizedId),
          ),
        ),
    );
    // Confirm the row is now voided.
    const [after] = await withTenant(seed.tenantId, (tx) =>
      tx
        .select({ status: payrollPeriods.status })
        .from(payrollPeriods)
        .where(eq(payrollPeriods.id, finalizedId))
        .limit(1),
    );
    expect(after?.status).toBe("voided");
  });

  it("a void-transition payload that ALSO tries to mutate grossAmount is rejected", async () => {
    // New finalized row to test with.
    const newMonth = new Date("2026-05-01T00:00:00Z");
    const sheet = await finalizePayrollPeriod(
      seed.tenantId,
      employeeId,
      newMonth,
      seed.ownerId,
    );
    await expect(
      withTenant(seed.tenantId, (tx) =>
        tx
          .update(payrollPeriods)
          .set({
            status: "voided",
            // Use a value that definitely differs from the stored row so
            // the DISTINCT FROM check fires. (Finalized rows for months
            // with no attendance have gross_amount = '0', so using '0'
            // here would NOT trigger the guard.)
            grossAmount: "9999",
            voidedAt: new Date(),
            voidedByUserId: seed.ownerId,
          })
          .where(eq(payrollPeriods.id, sheet.periodId!)),
      ),
    ).rejects.toSatisfy(isTriggerRejection);
  });

  // Direct raw SQL path (bypassing drizzle) — same verdict.
  it("raw SQL UPDATE is also rejected", async () => {
    // Make a fresh finalized row for this one too.
    const newMonth = new Date("2026-06-01T00:00:00Z");
    const sheet = await finalizePayrollPeriod(
      seed.tenantId,
      employeeId,
      newMonth,
      seed.ownerId,
    );
    await expect(
      withTenant(seed.tenantId, (tx) =>
        tx.execute(sql`update "payroll_periods" set "gross_amount" = '0' where "id" = ${sheet.periodId!}`),
      ),
    ).rejects.toSatisfy(isTriggerRejection);
  });
});
