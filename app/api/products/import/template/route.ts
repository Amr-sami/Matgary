import { NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { buildTemplateCsv } from "@/lib/repo/product-import";

export const runtime = "nodejs";

/**
 * Returns a sample CSV pre-populated with the active branch's category
 * keys so the cashier has a working template. Headers + 3 example rows
 * (one with attribute_values, one without SKU, one with full data).
 *
 * Served with a UTF-8 BOM so Excel renders Arabic characters correctly
 * when double-clicking the downloaded file (without the BOM, Excel
 * defaults to its system codepage and renders question marks).
 */
export async function GET() {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;

  const csv = await buildTemplateCsv(r.ctx.tenantId, r.ctx.branchId);
  // ﻿ is the UTF-8 BOM. Required for Excel to detect UTF-8.
  const bodyWithBom = "﻿" + csv + "\n";

  return new NextResponse(bodyWithBom, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="products-import-template.csv"',
    },
  });
}
