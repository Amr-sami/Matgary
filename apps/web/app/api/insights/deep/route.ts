import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  getAccessibleBranches,
  resolveActiveBranch,
} from "@/lib/api/branch-context";
import {
  loadBranchComparison,
  loadCompareReport,
  loadHeatmapReport,
  loadPaymentMixReport,
  loadProductDrillDown,
  searchDrillableProducts,
} from "@/lib/repo/insights-deep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every deep-dive report the /insights → Deep dive tab renders. One endpoint,
// dispatched by `?report=…`, so the client keeps a single fetcher hook and
// permission checks live in one place. The response shape is discriminated
// by the `report` field on the way out.

const REPORTS = [
  "compare",
  "heatmap",
  "payments",
  "branches",
  "product",
  "product-search",
] as const;

const querySchema = z
  .object({
    report: z.enum(REPORTS),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    branchId: z.union([z.string().uuid(), z.literal("all")]).optional(),
    productId: z.string().uuid().optional(),
    q: z.string().max(120).optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.from && !v.to) || (!v.from && v.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "from and to must be provided together",
      });
    }
    if (v.report === "compare" && (!v.from || !v.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "compare requires a finite window",
      });
    }
    if (v.report === "product" && !v.productId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "product report requires productId",
      });
    }
  });

export async function GET(req: NextRequest) {
  const r = await requirePermission("view_insights");
  if (!r.ok) return r.response;

  const parsed = querySchema.safeParse({
    report: req.nextUrl.searchParams.get("report") ?? undefined,
    from: req.nextUrl.searchParams.get("from") ?? undefined,
    to: req.nextUrl.searchParams.get("to") ?? undefined,
    branchId: req.nextUrl.searchParams.get("branchId") ?? undefined,
    productId: req.nextUrl.searchParams.get("productId") ?? undefined,
    q: req.nextUrl.searchParams.get("q") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid query" },
      { status: 400 },
    );
  }
  const { report, from, to, branchId, productId, q } = parsed.data;

  const window =
    from && to
      ? { from: new Date(from), to: new Date(to) }
      : null;

  // Same branch-scope rules as the overview endpoint:
  //   "all" → owner only, aggregates every branch
  //   uuid → must be in caller's allow-list
  //   omitted → default to caller's active branch
  let branchFilter: string | null;
  if (branchId === "all") {
    if (r.ctx.role !== "owner") {
      return NextResponse.json(
        { error: "ALL_BRANCHES_OWNER_ONLY" },
        { status: 403 },
      );
    }
    branchFilter = null;
  } else if (branchId) {
    const allowed = await getAccessibleBranches(r.ctx);
    if (!allowed.includes(branchId)) {
      return NextResponse.json({ error: "FORBIDDEN_BRANCH" }, { status: 403 });
    }
    branchFilter = branchId;
  } else {
    const active = await resolveActiveBranch(r.ctx);
    branchFilter = active?.branchId ?? null;
  }

  try {
    switch (report) {
      case "compare": {
        // superRefine above guarantees window is present.
        const data = await loadCompareReport(
          r.ctx.tenantId,
          window!,
          branchFilter,
        );
        return NextResponse.json({ report, ...data });
      }
      case "heatmap": {
        const data = await loadHeatmapReport(
          r.ctx.tenantId,
          window,
          branchFilter,
        );
        return NextResponse.json({ report, ...data });
      }
      case "payments": {
        const data = await loadPaymentMixReport(
          r.ctx.tenantId,
          window,
          branchFilter,
        );
        return NextResponse.json({ report, ...data });
      }
      case "branches": {
        // Comparison across branches only makes sense in the "all branches"
        // scope — owner sees every branch line up side by side.
        if (r.ctx.role !== "owner") {
          return NextResponse.json(
            { error: "OWNER_ONLY" },
            { status: 403 },
          );
        }
        const data = await loadBranchComparison(r.ctx.tenantId, window);
        return NextResponse.json({ report, ...data });
      }
      case "product": {
        const data = await loadProductDrillDown(
          r.ctx.tenantId,
          productId!,
          window,
          branchFilter,
        );
        if (!data) {
          return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
        }
        return NextResponse.json({ report, ...data });
      }
      case "product-search": {
        const data = await searchDrillableProducts(
          r.ctx.tenantId,
          q ?? "",
          window,
          branchFilter,
        );
        return NextResponse.json({ report, hits: data });
      }
    }
  } catch (err) {
    console.error("[insights/deep] load failed:", err);
    return NextResponse.json(
      { error: "failed to load report" },
      { status: 500 },
    );
  }
}
