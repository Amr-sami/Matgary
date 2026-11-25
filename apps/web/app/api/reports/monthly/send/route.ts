// QA / cron trigger for the monthly report push. Owner-only, rate-limited.
// Mirrors apps/web/app/api/reports/weekly/send/route.ts.

import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { fanoutEvent } from "@/lib/notifications/dispatch";
import { loadInsightsOverview } from "@/lib/repo/insights";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";

function lastClosedMonth(): { period: string; from: Date; to: Date } {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  const period = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}`;
  return { period, from: first, to: last };
}

function parseOrDefault(raw: string | undefined): { period: string; from: Date; to: Date } {
  if (raw) {
    const m = /^(\d{4})-(\d{2})$/.exec(raw);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const from = new Date(y, mo - 1, 1);
      const to = new Date(y, mo, 0, 23, 59, 59, 999);
      return { period: raw, from, to };
    }
  }
  return lastClosedMonth();
}

export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  if (r.ctx.role !== "owner") {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  const body = (await req.json().catch(() => ({}))) as { period?: string };
  const month = parseOrDefault(body.period);

  // Storo has no branches — aggregate the whole tenant.
  let totalRevenueEgp: number | null = null;
  let salesCount: number | null = null;
  try {
    const ov = await loadInsightsOverview(
      r.ctx.tenantId,
      { from: month.from, to: month.to },
      null,
    );
    totalRevenueEgp = Math.round(ov.metrics.totalRevenue);
    salesCount = ov.metrics.totalSales;
  } catch {
    /* preview best-effort */
  }

  await fanoutEvent(r.ctx.tenantId, null, "report.monthly", {
    period: month.period,
    totalRevenueEgp,
    salesCount,
    link: `/reports/monthly?period=${encodeURIComponent(month.period)}`,
  });

  return NextResponse.json({ ok: true, period: month.period });
}
