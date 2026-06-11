import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { requirePermission } from "@/lib/api/auth-helpers";
import { db } from "@/lib/db";
import { branches, tenants } from "@/lib/db/schema";
import { computeDigest } from "@/lib/repo/digest";
import { renderDigestMessage } from "@/lib/digest/render";

// Returns today's digest as it would be sent right now. Used by the
// "Preview" button on /settings/digest. Read-only; doesn't insert a
// digest_runs row.
export async function GET(req: NextRequest) {
  const r = await requirePermission("manage_digest_settings");
  if (!r.ok) return r.response;

  const branchId = req.nextUrl.searchParams.get("branchId");
  if (!branchId) {
    return NextResponse.json({ error: "branchId required" }, { status: 400 });
  }
  const localeParam = req.nextUrl.searchParams.get("locale");
  const locale: "ar" | "en" = localeParam === "en" ? "en" : "ar";

  const [branch] = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.tenantId, r.ctx.tenantId), eq(branches.id, branchId)))
    .limit(1);
  if (!branch) {
    return NextResponse.json({ error: "branch not found" }, { status: 404 });
  }

  const [tenant] = await db
    .select({ tz: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, r.ctx.tenantId))
    .limit(1);
  const tz = tenant?.tz ?? "Africa/Cairo";

  const dateRows = (await db.execute(sql`
    select (now() at time zone ${tz})::date::text as today
  `)) as unknown as
    | { today: string }[]
    | { rows: { today: string }[] };
  const today = Array.isArray(dateRows)
    ? dateRows[0]?.today
    : dateRows?.rows?.[0]?.today;
  if (!today) {
    return NextResponse.json({ error: "tz resolution failed" }, { status: 500 });
  }

  const payload = await computeDigest(r.ctx.tenantId, branchId, today);
  const dashboardBase = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const message = renderDigestMessage(payload, {
    locale,
    dashboardUrl: `${dashboardBase}/?branch=${branchId}`,
  });
  return NextResponse.json({ payload, message });
}
