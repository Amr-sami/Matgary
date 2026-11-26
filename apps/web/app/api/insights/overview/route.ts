import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  getAccessibleBranches,
  resolveActiveBranch,
} from "@/lib/api/branch-context";
import { loadInsightsOverview } from "@/lib/repo/insights";
import { withTenant } from "@/lib/db";
import { branches } from "@/lib/db/schema";

export const runtime = "nodejs";
// Aggregations change as soon as a new sale lands and the cache busts; we
// don't want a CDN/Edge proxy to cache the response and serve a 60 s old
// figure to a tenant that just closed a sale.
export const dynamic = "force-dynamic";

// `from`/`to` arrive as ISO 8601 strings. Both must be present together (or
// both absent) — a half-open window would silently lose the prior-period
// comparison the UI needs. Hard upper bound on range to keep the grouping
// query bounded.
const MAX_RANGE_DAYS = 366 * 2; // two years; longer ranges are a UI mistake

const querySchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    /** "all" = aggregate every branch the user can see; a uuid = restrict to
     *  that branch; omitted = use the active branch from cookie context. */
    branchId: z.union([z.string().uuid(), z.literal("all")]).optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.from && !v.to) || (!v.from && v.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "from and to must be provided together",
      });
    }
    if (v.from && v.to) {
      const from = new Date(v.from);
      const to = new Date(v.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "invalid date",
        });
        return;
      }
      if (from.getTime() > to.getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "from must be <= to",
        });
      }
      const days = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
      if (days > MAX_RANGE_DAYS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `range exceeds ${MAX_RANGE_DAYS} days`,
        });
      }
    }
  });

export async function GET(req: NextRequest) {
  const r = await requirePermission("view_insights");
  if (!r.ok) return r.response;

  const parsed = querySchema.safeParse({
    from: req.nextUrl.searchParams.get("from") ?? undefined,
    to: req.nextUrl.searchParams.get("to") ?? undefined,
    branchId: req.nextUrl.searchParams.get("branchId") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid query" },
      { status: 400 },
    );
  }

  const window =
    parsed.data.from && parsed.data.to
      ? { from: new Date(parsed.data.from), to: new Date(parsed.data.to) }
      : null;

  // Resolve the branch filter. Three cases:
  //   - "all": owner only — every branch in the tenant. Staff get 403.
  //   - explicit uuid: must be in the user's allow-list, else 403.
  //   - omitted: default to the user's active branch from cookie context.
  let branchFilter: string | null;
  if (parsed.data.branchId === "all") {
    if (r.ctx.role !== "owner") {
      return NextResponse.json(
        { error: "ALL_BRANCHES_OWNER_ONLY" },
        { status: 403 },
      );
    }
    branchFilter = null;
  } else if (parsed.data.branchId) {
    const allowed = await getAccessibleBranches(r.ctx);
    if (!allowed.includes(parsed.data.branchId)) {
      return NextResponse.json({ error: "FORBIDDEN_BRANCH" }, { status: 403 });
    }
    branchFilter = parsed.data.branchId;
  } else {
    const active = await resolveActiveBranch(r.ctx);
    branchFilter = active?.branchId ?? null;
  }

  try {
    const data = await loadInsightsOverview(
      r.ctx.tenantId,
      window,
      branchFilter,
    );
    return NextResponse.json({ ...data, branchId: branchFilter });
  } catch (err) {
    // Don't leak internal errors to the client; log for ops.
    console.error("[insights/overview] load failed:", err);
    return NextResponse.json(
      { error: "failed to load insights" },
      { status: 500 },
    );
  }
}
