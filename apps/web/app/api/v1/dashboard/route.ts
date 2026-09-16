import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { resolveBranchFilter } from "@/lib/api/branch-context";
import { loadDashboardStats } from "@/lib/repo/insights";
import { listProducts } from "@/lib/repo/catalog";

// GET /api/v1/dashboard — everything the native home screen paints, in one
// round-trip.
//
// The web dashboard (app/page.tsx) streams three Server Components that each
// do their own repo read. A native client has no streaming SC equivalent: it
// would have to fire three requests and pay three TLS round-trips on a cold
// 3G start. So the two reads the home screen actually needs — the headline
// stats and the low-stock alert list — are merged here. Recent sales are NOT
// bundled: that list is paginated and already lives at its own endpoint, so
// folding it in would make this response grow without bound.
//
// No new aggregation is written here. `loadDashboardStats` is the same
// function <StatsGridServer> calls (cached per tenant/branch/calendar day),
// and the low-stock split reproduces <LowStockAlertServer> exactly — same
// `listProducts` read, same out-of-stock-before-low-stock ordering.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cap on the alert list. The web widget renders every matching product inside
 * a scroll container because the rows are already in memory; a phone on a
 * metered connection is not. A tenant mid-stocktake can have hundreds of
 * zero-quantity rows, and nobody acts on alert #51 from a home screen — the
 * full list is one tap away at /inventory. `counts` below still reports the
 * untruncated totals so the UI can show "+N more".
 */
const LOW_STOCK_LIMIT = 50;

// `?branchId=` is either the "all" sentinel or a branch uuid. Shape is
// validated here so a malformed value returns a machine code instead of
// falling through to resolveBranchFilter's FORBIDDEN_BRANCH, which would
// tell a native client to re-authenticate over what is really a client bug.
const querySchema = z.object({
  branchId: z.union([z.literal("all"), z.string().uuid()]).nullable(),
});

export async function GET(req: NextRequest) {
  // requireTenantWithBranch (not plain requireTenant) so a staff row with no
  // accessible branch is rejected with NO_BRANCH_ACCESS before we read
  // anything, and so the response can carry the active-branch context the
  // native app needs to render its branch switcher without a second call.
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;

  const parsed = querySchema.safeParse({
    branchId: req.nextUrl.searchParams.get("branchId"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_BRANCH_ID" }, { status: 400 });
  }

  // Shared resolver — identical semantics to every web list route:
  //   "all"    → owner-only, null filter (aggregate across the tenant)
  //   <uuid>   → must be in the caller's allow-list
  //   omitted  → the active branch (X-Branch-Id header, else mg.branch cookie)
  const filter = await resolveBranchFilter(r.ctx, parsed.data.branchId);
  if (!filter.ok) {
    return NextResponse.json(
      { error: filter.error },
      { status: filter.status },
    );
  }
  const branchId = filter.branchId;

  // Independent reads — run them concurrently rather than serially, since the
  // whole point of this route is to shorten a cold start.
  const [stats, products] = await Promise.all([
    loadDashboardStats(r.ctx.tenantId, branchId),
    listProducts(r.ctx.tenantId, branchId),
  ]);

  // Same partition as <LowStockAlertServer>: quantity 0 is "out of stock",
  // 0 < quantity <= threshold is "low". Kept as two buckets rather than one
  // sorted list because the two render differently (danger vs warning) and
  // the client should not have to re-derive the boundary.
  const outOfStock = products.filter((p) => p.quantity === 0);
  const lowStock = products.filter(
    (p) => p.quantity > 0 && p.quantity <= p.lowStockThreshold,
  );

  const toAlert = (p: (typeof products)[number]) => ({
    id: p.id,
    name: p.name,
    sku: p.sku ?? null,
    categoryId: p.category,
    brand: p.brand ?? null,
    quantity: p.quantity,
    lowStockThreshold: p.lowStockThreshold,
  });

  // Out-of-stock first (it is the more urgent bucket), then low stock by
  // how close to zero it is — the order a shopkeeper would restock in.
  const items = [
    ...outOfStock,
    ...lowStock.slice().sort((a, b) => a.quantity - b.quantity),
  ]
    .slice(0, LOW_STOCK_LIMIT)
    .map(toAlert);

  return NextResponse.json(
    {
      branch: {
        // null id means the caller asked for "all branches"; the active-branch
        // fields still describe where they are currently standing.
        id: branchId,
        allBranches: branchId === null,
        activeBranchId: r.ctx.branchId,
        activeBranchName: r.ctx.branchName,
        allowedBranchIds: r.ctx.allowedBranchIds,
      },
      stats,
      lowStock: {
        outOfStockCount: outOfStock.length,
        lowStockCount: lowStock.length,
        // True when the client is looking at a clipped list, so it can show
        // a "view all" affordance instead of implying these are all of them.
        truncated: outOfStock.length + lowStock.length > items.length,
        items,
      },
      generatedAt: new Date().toISOString(),
    },
    {
      // Stock and today's revenue both move on every sale. Anything cached
      // between the phone and here would show a number the POS has already
      // invalidated; the 60 s Redis layer inside loadDashboardStats is the
      // only caching this response wants.
      headers: { "Cache-Control": "no-store" },
    },
  );
}
