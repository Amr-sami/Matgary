// GET /api/financials/overview — the flat KPI view of a period.
//
// Reads tenant-scoped sales / returns / expenses / payroll / money_movements
// via the engine (lib/finance/pnl.ts). Never consults /api/insights/overview;
// that endpoint is intentionally left untouched for Slice 1 so existing
// mobile/web Insights screens keep their current behavior.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { count, eq, and, gte, lt } from "drizzle-orm";

import { requirePermission } from "@/lib/api/auth-helpers";
import { withTenant } from "@/lib/db";
import { returns as returnsTable, sales as salesTable } from "@/lib/db/schema";
import {
  DEFAULT_REPORTING_TZ,
  isDatePresetKey,
  resolvePreset,
  type DatePresetKey,
} from "@/lib/finance/dates";
import {
  computePnLFromSource,
  fetchPnLSource,
  overviewFromPnl,
} from "@/lib/finance/pnl";

const querySchema = z.object({
  preset: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export async function GET(req: NextRequest) {
  // `view_financials` gates the entire Financials section. Enforced from
  // day one — the Financials surface ships with its permissions already
  // curated (the existing view_expenses/view_insights audit ramp is a
  // legacy rollout issue; new permission keys are enforced immediately,
  // same precedent as the digital-collections keys).
  const r = await requirePermission("view_financials");
  if (!r.ok) return r.response;

  const parsed = querySchema.safeParse({
    preset: req.nextUrl.searchParams.get("preset") ?? undefined,
    from: req.nextUrl.searchParams.get("from") ?? undefined,
    to: req.nextUrl.searchParams.get("to") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  const preset: DatePresetKey = isDatePresetKey(parsed.data.preset)
    ? parsed.data.preset
    : parsed.data.from && parsed.data.to
      ? "custom"
      : "this_month";

  const period = resolvePreset(preset, {
    tz: DEFAULT_REPORTING_TZ,
    customFrom: parsed.data.from,
    customTo: parsed.data.to,
  });

  const source = await fetchPnLSource(r.ctx.tenantId, period);
  const pnl = computePnLFromSource(source);

  // Sales & returns counts — one tenant-scoped SELECT each. The engine's
  // source already has sales and returns, but we count rows at the DB for
  // the overview summary so "0 sales" is always 0 rather than source.length
  // (which only counts loaded columns).
  const counts = await withTenant(r.ctx.tenantId, async (tx) => {
    const [salesC] = await tx
      .select({ n: count() })
      .from(salesTable)
      .where(
        and(
          eq(salesTable.tenantId, r.ctx.tenantId),
          gte(salesTable.saleDate, period.from),
          lt(salesTable.saleDate, period.to),
        ),
      );
    const [returnsC] = await tx
      .select({ n: count() })
      .from(returnsTable)
      .where(
        and(
          eq(returnsTable.tenantId, r.ctx.tenantId),
          gte(returnsTable.returnDate, period.from),
          lt(returnsTable.returnDate, period.to),
        ),
      );
    return {
      sales: Number(salesC?.n ?? 0),
      returns: Number(returnsC?.n ?? 0),
    };
  });

  const overview = overviewFromPnl(
    pnl,
    period,
    counts.sales,
    counts.returns,
    source.moneyMovements,
  );

  return NextResponse.json({ data: overview, preset });
}
