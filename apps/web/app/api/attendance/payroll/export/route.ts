import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import { computePeriodGross } from "@/lib/repo/payroll";
import { listTeamMembers } from "@/lib/repo/team";

export async function GET(req: NextRequest) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  const periodStart = fromStr ? new Date(fromStr) : startOfMonth(new Date());
  const periodEnd = toStr ? new Date(toStr) : endOfMonth(new Date());

  const members = (await listTeamMembers(r.ctx.tenantId)).filter(
    (m) => m.role !== "owner",
  );

  const rows: string[] = [];
  rows.push(
    [
      "الموظف",
      "اسم الدخول",
      "ساعات أساسية",
      "ساعات إضافية",
      "تنبيهات",
      "إجمالي (ج.م)",
    ].join(","),
  );

  for (const m of members) {
    const g = await computePeriodGross(
      r.ctx.tenantId,
      m.userId,
      periodStart,
      periodEnd,
    );
    rows.push(
      [
        csv(m.displayName),
        csv(m.username),
        g.regularHours,
        g.overtimeHours,
        g.reviewCount,
        g.grossAmount,
      ].join(","),
    );
  }

  // BOM so Excel recognizes the file as UTF-8 with Arabic text intact.
  const body = "﻿" + rows.join("\n");
  const periodLabel = `${periodStart.toISOString().slice(0, 10)}_${periodEnd
    .toISOString()
    .slice(0, 10)}`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payroll_${periodLabel}.csv"`,
    },
  });
}

function csv(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
