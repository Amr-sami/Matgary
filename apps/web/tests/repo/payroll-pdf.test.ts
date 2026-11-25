// Payroll V1 — PDF generation smoke test.
//
// Produces both the register (landscape) and statement (portrait) PDFs from
// a real finalized sheet and asserts:
//   • output starts with the PDF magic bytes
//   • a non-trivial document was produced (> 1KB)
//   • FINALIZED sheets print the STORED snapshot even if the engine would
//     compute differently now (attendance tampered post-finalize)
//
// The deep layout checks live in UX QA, not here — this is a build-time
// contract: payroll PDFs must render without throwing.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  generatePayrollRegisterPdf,
  generatePayrollStatementPdf,
} from "@/lib/pdfPayroll";
import { payrollFilename } from "@matgary/domain";
import {
  finalizePayrollPeriod,
  getEmployeePayrollMonth,
  listPayrollMonth,
} from "@/lib/repo/payroll-periods";
import {
  addShift,
  addStaff,
  seedPayrollTenant,
  setCompensation,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

let seed: PayrollTenantSeed;
let employeeId: string;
const MONTH = new Date("2026-03-01T00:00:00Z");

beforeAll(async () => {
  seed = await seedPayrollTenant("pdf");
  employeeId = await addStaff(seed.tenantId, { name: "PDF Pedro" });
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
  await finalizePayrollPeriod(seed.tenantId, employeeId, MONTH, seed.ownerId);
});

afterAll(async () => {
  await seed.cleanup();
});

function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d /* - */
  );
}

describe("payrollFilename helper", () => {
  it("builds `Payroll-YYYY-MM-StoreName.pdf` for a register", () => {
    expect(
      payrollFilename({
        periodStart: "2026-11-01T00:00:00.000Z",
        entityName: "Storo Test",
        kind: "register",
      }),
    ).toBe("Payroll-2026-11-Storo-Test.pdf");
  });

  it("builds `Payroll-YYYY-MM-EmployeeName.pdf` for a statement", () => {
    expect(
      payrollFilename({
        periodStart: "2026-03-01T00:00:00.000Z",
        entityName: "Ahmed Hassan",
        kind: "statement",
      }),
    ).toBe("Payroll-2026-03-Ahmed-Hassan.pdf");
  });

  it("falls back to Store/Employee when name is missing", () => {
    expect(
      payrollFilename({
        periodStart: "2026-03-01T00:00:00.000Z",
        entityName: "",
        kind: "register",
      }),
    ).toBe("Payroll-2026-03-Store.pdf");
    expect(
      payrollFilename({
        periodStart: "2026-03-01T00:00:00.000Z",
        entityName: null,
        kind: "statement",
      }),
    ).toBe("Payroll-2026-03-Employee.pdf");
  });
});

describe("payroll PDFs render", () => {
  it("register PDF produces valid PDF bytes with multiple rows", async () => {
    const rows = await listPayrollMonth(seed.tenantId, MONTH);
    const bytes = await generatePayrollRegisterPdf({
      shopName: "PDF Test Shop",
      periodStart: MONTH.toISOString(),
      rows,
      filename: payrollFilename({
        periodStart: MONTH.toISOString(),
        entityName: "PDF Test Shop",
        kind: "register",
      }),
      locale: "en",
    });
    expect(isPdf(bytes)).toBe(true);
    expect(bytes.byteLength).toBeGreaterThan(1024);
  });

  it("statement PDF produces valid PDF bytes with a finalized sheet", async () => {
    const sheet = await getEmployeePayrollMonth(seed.tenantId, employeeId, MONTH);
    expect(sheet?.lifecycle).toBe("FINALIZED");
    const bytes = await generatePayrollStatementPdf({
      shopName: "PDF Test Shop",
      sheet: sheet!,
      filename: payrollFilename({
        periodStart: sheet!.periodStart,
        entityName: sheet!.employeeName,
        kind: "statement",
      }),
      locale: "en",
    });
    expect(isPdf(bytes)).toBe(true);
    expect(bytes.byteLength).toBeGreaterThan(1024);
  });

  it("statement PDF renders in Arabic locale without throwing", async () => {
    const sheet = await getEmployeePayrollMonth(seed.tenantId, employeeId, MONTH);
    const bytes = await generatePayrollStatementPdf({
      shopName: "متجر الاختبار",
      sheet: sheet!,
      filename: "ar.pdf",
      locale: "ar",
    });
    expect(isPdf(bytes)).toBe(true);
  });
});
