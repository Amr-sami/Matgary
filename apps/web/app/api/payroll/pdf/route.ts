// GET /api/payroll/pdf?month=YYYY-MM[&employeeId=UUID]
//
//   • month only            → register PDF (landscape, all employees)
//   • month + employeeId    → single-employee statement PDF (portrait)
//
// Permission: `manage_payroll`. Server-side only — no client-side payroll
// arithmetic is trusted. For FINALIZED rows the generator renders the
// stored snapshot; for DRAFT / MISSING the live engine result.

import { NextRequest, NextResponse } from "next/server";
import { payrollFilename } from "@matgary/domain";

import { requirePermission } from "@/lib/api/auth-helpers";
import {
  generatePayrollRegisterPdf,
  generatePayrollStatementPdf,
} from "@/lib/pdfPayroll";
import {
  getEmployeePayrollMonth,
  listPayrollMonth,
} from "@/lib/repo/payroll-periods";
import { getShopSettings } from "@/lib/repo/settings";
import { getPrimaryBranchId } from "@/lib/api/branch-context";
import { parseMonthParam } from "../_shared";

export async function GET(req: NextRequest) {
  const r = await requirePermission("manage_payroll");
  if (!r.ok) return r.response;

  const month = req.nextUrl.searchParams.get("month") ?? "";
  const employeeId = req.nextUrl.searchParams.get("employeeId");
  const periodStart = parseMonthParam(month);
  if (!periodStart) {
    return NextResponse.json({ error: "invalid_month" }, { status: 400 });
  }

  // Shop name comes from the tenant's primary branch — matches receipts.
  const branchId = await getPrimaryBranchId(r.ctx.tenantId);
  const settings = branchId ? await getShopSettings(r.ctx.tenantId, branchId) : null;
  const shopName = settings?.shopName || "Storo";
  // Locale preference: the `?locale=` query param wins; otherwise fall back
  // to Arabic since Storo's default UI locale is Arabic.
  const localeParam = req.nextUrl.searchParams.get("locale");
  const locale: "en" | "ar" = localeParam === "en" ? "en" : "ar";

  if (employeeId) {
    const sheet = await getEmployeePayrollMonth(r.ctx.tenantId, employeeId, periodStart);
    if (!sheet) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const filename = payrollFilename({
      periodStart: sheet.periodStart,
      entityName: sheet.employeeName,
      kind: "statement",
    });
    const bytes = await generatePayrollStatementPdf({
      shopName,
      sheet,
      filename,
      locale,
    });
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  const rows = await listPayrollMonth(r.ctx.tenantId, periodStart);
  const filename = payrollFilename({
    periodStart: periodStart.toISOString(),
    entityName: shopName,
    kind: "register",
  });
  const bytes = await generatePayrollRegisterPdf({
    shopName,
    periodStart: periodStart.toISOString(),
    rows,
    filename,
    locale,
  });
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
