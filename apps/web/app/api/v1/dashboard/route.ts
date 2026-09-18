import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { resolveBranchFilter } from "@/lib/api/branch-context";
import { loadDashboardStats } from "@/lib/repo/insights";
import { listProducts } from "@/lib/repo/catalog";
import { listSalesPage } from "@/lib/repo/operations";
import type { Sale } from "@/lib/types";

// GET /api/v1/dashboard — everything the native home screen paints, in one
// round-trip.
//
// The web dashboard (app/page.tsx) streams three Server Components that each
// do their own repo read. A native client has no streaming SC equivalent: it
// would have to fire three requests and pay three TLS round-trips on a cold
// 3G start. So the three reads the home screen actually needs — the headline
// stats, the low-stock alert list and a short recent-sales strip — are merged
// here. The recent-sales block is a fixed-size summary (RECENT_SALES_LIMIT
// invoices), not the paginated feed: the full history lives at its own
// endpoint, so this response cannot grow without bound.
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

/**
 * Number of recent invoices in the home-screen strip. The web widget
 * (<RecentSalesListServer>) shows 10 *lines*; the phone shows 8 *invoices*
 * because a cart sale is one event to a shopkeeper, not five rows, and the
 * card list sits below four KPI tiles on a ~700pt viewport.
 */
const RECENT_SALES_LIMIT = 8;

/**
 * `sales` rows are single product lines; a cart sale is N rows sharing an
 * invoiceId. We pull a fixed slab of rows in the (saleDate desc, id desc)
 * order listSalesPage returns and fold them into invoices here rather than
 * adding a GROUP BY query to the repo — same read the web dashboard makes,
 * just wider. 60 rows covers 8 invoices unless a tenant rings up 7+ line
 * carts back to back, and the fold below drops any invoice the slab boundary
 * may have split instead of showing a wrong total for it.
 */
const RECENT_SALES_ROW_FETCH = 60;

interface RecentSaleSummary {
  /** A sale row id inside the invoice (the newest line) — what /sales/[id] opens. */
  id: string;
  /** Shared invoice ref for cart sales; null for a legacy single-line sale. */
  invoiceId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  /** Sum of the invoice's line totals (after line discounts), same as the customers repo. */
  total: number;
  paymentMethod: Sale["paymentMethod"] | null;
  /** ISO saleDate — the moment the sale was rung up (or its custom date). */
  createdAt: string;
  /** Units sold across the invoice (sum of quantitySold) — what "{n} قطعة" counts. */
  itemCount: number;
  /** True when every line on the invoice has been returned. */
  isReturned: boolean;
  isPaid: boolean;
}

/**
 * Fold newest-first sale rows into invoices, keyed on invoiceId (a legacy row
 * without one is its own single-line invoice), preserving first-seen order —
 * the same grouping the client's groupInvoices helper does. Keyed rather than
 * by adjacency because an invoice's lines are *not* guaranteed contiguous in
 * (saleDate desc, id desc): the web SaleForm stamps every backdated sale at
 * T12:00:00, so two backdated carts on one day share a saleDate and interleave
 * by random uuid, and PATCH /api/sales/[id] can move a single line's date.
 *
 * `hasMore` tells us the slab was clipped. Every row past the boundary has a
 * saleDate <= the last row's, so any invoice with a line *at* that timestamp
 * may continue past it and is discarded rather than reported with a partial
 * total — whatever position it holds, even if that leaves fewer than
 * RECENT_SALES_LIMIT cards (seven right cards beat eight with one wrong).
 */
function foldRecentSales(rows: Sale[], hasMore: boolean): RecentSaleSummary[] {
  const byKey = new Map<string, RecentSaleSummary>();
  const order: RecentSaleSummary[] = [];
  // Oldest line timestamp per invoice — what decides whether it straddles
  // the slab boundary.
  const oldestLineAt = new Map<string, number>();
  for (const row of rows) {
    const key = row.invoiceId ?? `line:${row.id}`;
    const at = row.saleDate.getTime();
    oldestLineAt.set(key, Math.min(oldestLineAt.get(key) ?? at, at));
    const current = byKey.get(key);
    if (current) {
      current.itemCount += row.quantitySold;
      current.total += row.totalPrice;
      current.isReturned = current.isReturned && row.isReturned;
      current.isPaid = current.isPaid && row.isPaid !== false;
      // A cart carries one customer/payment, but a legacy row may lack the
      // fields the newest line has — fill from any line that has them.
      current.customerName ??= row.customerName ?? null;
      current.customerPhone ??= row.customerPhone ?? null;
      current.paymentMethod ??= row.paymentMethod ?? null;
      continue;
    }
    const group: RecentSaleSummary = {
      id: row.id,
      invoiceId: row.invoiceId ?? null,
      customerName: row.customerName ?? null,
      customerPhone: row.customerPhone ?? null,
      total: row.totalPrice,
      paymentMethod: row.paymentMethod ?? null,
      createdAt: row.saleDate.toISOString(),
      itemCount: row.quantitySold,
      isReturned: row.isReturned,
      isPaid: row.isPaid !== false,
    };
    byKey.set(key, group);
    order.push(group);
  }
  const boundaryAt =
    hasMore && rows.length > 0 ? rows[rows.length - 1].saleDate.getTime() : null;
  return order
    .filter(
      (g) =>
        boundaryAt === null ||
        g.invoiceId === null ||
        oldestLineAt.get(g.invoiceId) !== boundaryAt,
    )
    .slice(0, RECENT_SALES_LIMIT)
    .map((g) => ({
      ...g,
      // Line totals are numeric(…,2) in Postgres; summing floats can leave
      // 149.99000000000001 behind. Round once at the boundary.
      total: Math.round(g.total * 100) / 100,
    }));
}

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
  const [stats, products, salesPage] = await Promise.all([
    loadDashboardStats(r.ctx.tenantId, branchId),
    listProducts(r.ctx.tenantId, branchId),
    // Same repo read <RecentSalesListServer> makes, folded into invoices.
    listSalesPage(r.ctx.tenantId, { branchId, limit: RECENT_SALES_ROW_FETCH }),
  ]);
  const recentSales = foldRecentSales(salesPage.data, salesPage.nextCursor !== null);

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
      // Newest first. Empty array (never null) when the branch has no sales
      // yet, so the client renders its empty state instead of a guard.
      recentSales,
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
