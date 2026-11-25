// GET /api/inventory-counts/[id]/report.pdf?locale=ar|en
// Binary PDF for the native share sheet (mobile) or download (web).
// Content-Disposition carries the filename the OS shows in the share sheet.
//
// The locale decides the PDF language end-to-end. It is read, in order, from:
//   1. `?locale=` query string (mobile share passes the current app locale)
//   2. `Accept-Language` header
//   3. The tenant's default language
// If none resolve to "ar", the PDF renders in English.

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission } from "@/lib/api/auth-helpers";
import { withTenant } from "@/lib/db";
import { tenants } from "@/lib/db/schema";
import { getCountReport } from "@/lib/repo/inventory-counts";
import {
  generateInventoryCountPdf,
  inventoryCountPdfFilename,
  type ReportLocale,
} from "@/lib/pdfInventoryCount";

function resolveLocale(
  req: NextRequest,
  tenantLang: string | null | undefined,
): ReportLocale {
  const qp = req.nextUrl.searchParams.get("locale");
  if (qp === "ar" || qp === "en") return qp;
  const acc = req.headers.get("accept-language")?.toLowerCase() ?? "";
  if (acc.startsWith("ar") || acc.includes(",ar")) return "ar";
  if (acc.startsWith("en") || acc.includes(",en")) return "en";
  return tenantLang === "ar" ? "ar" : "en";
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("view_inventory_counts");
  if (!r.ok) return r.response;
  const { id } = await params;

  const report = await getCountReport(r.ctx.tenantId, id);
  if (!report) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const [tenant] = await withTenant(r.ctx.tenantId, (tx) =>
    tx
      .select({ name: tenants.name, currency: tenants.currency, language: tenants.language })
      .from(tenants)
      .where(eq(tenants.id, r.ctx.tenantId))
      .limit(1),
  );

  const locale = resolveLocale(req, tenant?.language);
  const filename = inventoryCountPdfFilename(report);
  const bytes = await generateInventoryCountPdf({
    report,
    shopName: tenant?.name ?? "Storo",
    currency: tenant?.currency ?? "EGP",
    filename,
    locale,
  });

  return new NextResponse(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
