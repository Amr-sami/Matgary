import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { requirePermission } from "@/lib/api/auth-helpers";
import { resolveBranchFilter } from "@/lib/api/branch-context";
import { db, withTenant } from "@/lib/db";
import { branches, tenants } from "@/lib/db/schema";
import { computeDigest } from "@/lib/repo/digest";
import { renderDigestMessage } from "@/lib/digest/render";

// Returns today's digest as it would be sent right now. Used by the
// "Preview" button on /settings/digest and by the native client. Read-only;
// doesn't insert a digest_runs row.
//
// Branch selection goes through resolveBranchFilter so it matches every other
// branch-scoped read: `?branchId=<uuid>` must be in the caller's allow-list,
// and when it is omitted the active branch is used (X-Branch-Id header, else
// the mg.branch cookie, else the user's primary branch).
export async function GET(req: NextRequest) {
  const r = await requirePermission("manage_digest_settings");
  if (!r.ok) return r.response;

  const filter = await resolveBranchFilter(
    r.ctx,
    req.nextUrl.searchParams.get("branchId"),
  );
  if (!filter.ok) {
    return NextResponse.json({ error: filter.error }, { status: filter.status });
  }
  // A digest is per-branch; "all" has no meaning here.
  if (!filter.branchId) {
    return NextResponse.json({ error: "branchId required" }, { status: 400 });
  }
  const branchId = filter.branchId;
  const localeParam = req.nextUrl.searchParams.get("locale");
  const locale: "ar" | "en" = localeParam === "en" ? "en" : "ar";

  // `branches` is FORCE ROW LEVEL SECURITY (migration 0014): the policy only
  // matches rows whose tenant_id equals the `app.tenant_id` setting, so this
  // read has to run inside withTenant. On the plain `db` client the setting is
  // unset, the policy matches nothing, and every branch looks "not found".
  const branch = await withTenant(r.ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(
        and(eq(branches.tenantId, r.ctx.tenantId), eq(branches.id, branchId)),
      )
      .limit(1);
    return row ?? null;
  });
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
  return NextResponse.json({ payload, message, branchId });
}
