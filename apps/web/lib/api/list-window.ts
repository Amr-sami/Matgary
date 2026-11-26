// Standard server-side time-window for time-series GET endpoints.
//
// Pattern (apply to every `/api/X` GET that returns time-ordered rows):
//
//   const since = resolveSinceWindow(req, { defaultDays: 60 });
//   const data = await listX(tenantId, branchId, since);
//
// Query-string contract:
//   ?all=1   → no cutoff (full history); use sparingly (exports, reports)
//   ?days=N  → cutoff at now() - N days (clamped to [1, 730])
//   (unset)  → uses the route's defaultDays
//
// Hot-path indexes (e.g. sales_tenant_branch_date_idx) make the resulting
// `... AND date >= $cutoff` a cheap range scan; without the cutoff the
// query plan degrades to a full-table sort on big tenants.

import type { NextRequest } from "next/server";

export function resolveSinceWindow(
  req: NextRequest,
  opts: { defaultDays: number },
): Date | undefined {
  const sp = req.nextUrl.searchParams;
  if (sp.get("all") === "1") return undefined;
  const daysRaw = sp.get("days");
  const days = daysRaw ? Math.min(730, Math.max(1, Number(daysRaw) || opts.defaultDays)) : opts.defaultDays;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
