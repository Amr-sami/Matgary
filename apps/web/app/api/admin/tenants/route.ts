import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import {
  listTenants,
  type TenantListFilters,
  type TenantStatus,
} from "@/lib/admin/tenants";
import {
  computeHealthAndRiskBatch,
  type HealthStatus,
  type RiskLevel,
} from "@/lib/admin/store-health";
import { lastActivityByTenant } from "@/lib/admin/presence-analytics";
import { listTenantCounts } from "@/lib/admin/tenant-counts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS_VALUES: TenantStatus[] = [
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "expired",
  "suspended",
];
const HEALTH_VALUES: HealthStatus[] = ["healthy", "attention", "at_risk"];
const RISK_VALUES: RiskLevel[] = ["healthy", "low", "medium", "high"];

function asStatus(s: string | null): TenantStatus | undefined {
  if (!s) return undefined;
  return (STATUS_VALUES as string[]).includes(s) ? (s as TenantStatus) : undefined;
}

function asHealth(s: string | null): HealthStatus | undefined {
  if (!s) return undefined;
  return (HEALTH_VALUES as string[]).includes(s) ? (s as HealthStatus) : undefined;
}

function asRisk(s: string | null): RiskLevel | undefined {
  if (!s) return undefined;
  return (RISK_VALUES as string[]).includes(s) ? (s as RiskLevel) : undefined;
}

export async function GET(req: NextRequest) {
  const r = await requirePermission("tenant.read");
  if (!r.ok) return r.response;

  const sp = req.nextUrl.searchParams;
  const healthFilter = asHealth(sp.get("health"));
  const riskFilter = asRisk(sp.get("risk"));
  const baseLimit = sp.get("limit")
    ? Math.min(200, Math.max(1, Number(sp.get("limit"))))
    : 50;

  // If the admin filtered by health/risk we have to compute those over a
  // wider slice before truncating, because the filter is a post-query
  // predicate (no indexed storage for the score yet). Cap the widening
  // factor at 4× so the worst-case payload stays bounded.
  //
  // Scale note: this starts to clip legitimately matching rows once the
  // non-matching fraction exceeds (widened − baseLimit) / widened ≈ 75%.
  // For baseLimit=50 and widened=200, that's safe for any filter that
  // matches ≥25% of tenants. The platform-wide EXACT per-level counts
  // (Overview "Requires Attention" panel) come from the SQL aggregator and
  // never sample, so the headline KPIs are not affected.
  //
  // The response carries a `truncated` flag: when true, the list client
  // shows "Showing the first N — filter may include additional tenants"
  // so the admin never mistakes the view for exhaustive.
  const widened = healthFilter || riskFilter ? baseLimit * 4 : baseLimit;

  const filters: TenantListFilters = {
    status: asStatus(sp.get("status")),
    plan: sp.get("plan") || undefined,
    branchCount:
      sp.get("branchCount") === "1" ||
      sp.get("branchCount") === "2-3" ||
      sp.get("branchCount") === "4+"
        ? (sp.get("branchCount") as "1" | "2-3" | "4+")
        : undefined,
    trialExpiringInDays: sp.get("trialExpiringInDays")
      ? Math.min(30, Math.max(0, Number(sp.get("trialExpiringInDays"))))
      : undefined,
    q: sp.get("q") || undefined,
    sort:
      sp.get("sort") === "created_at" ||
      sp.get("sort") === "last_login" ||
      sp.get("sort") === "mrr"
        ? (sp.get("sort") as "created_at" | "last_login" | "mrr")
        : undefined,
    limit: widened,
    offset: sp.get("offset") ? Math.max(0, Number(sp.get("offset"))) : undefined,
  };

  const base = await listTenants(filters);
  const [healthRisk, lastActivityMap, counts] = await Promise.all([
    computeHealthAndRiskBatch(base.map((b) => b.id)),
    lastActivityByTenant(base.map((b) => b.id)),
    listTenantCounts(base.map((b) => b.id)),
  ]);

  let enriched = base.map((row) => {
    const hr = healthRisk.get(row.id);
    const c = counts.get(row.id) ?? {
      products: 0,
      categories: 0,
      customers: 0,
      suppliers: 0,
    };
    return {
      ...row,
      health: hr
        ? { score: hr.health.score, status: hr.health.status }
        : null,
      risk: hr ? { level: hr.risk.level, score: hr.risk.score } : null,
      lastActivityAt: lastActivityMap.get(row.id) ?? null,
      productCount: c.products,
      categoryCount: c.categories,
      customerCount: c.customers,
      supplierCount: c.suppliers,
    };
  });

  if (healthFilter) {
    enriched = enriched.filter((r) => r.health?.status === healthFilter);
  }
  if (riskFilter) {
    enriched = enriched.filter((r) => r.risk?.level === riskFilter);
  }

  // Truncation detection: we widened the fetch when a health/risk filter is
  // active. If the base query returned the full widened page AND the filter
  // kept at least one row, matches outside the widened window are possible.
  // Expose it so the UI can render a "may include more" hint.
  const filterApplied = !!(healthFilter || riskFilter);
  const possiblyTruncated =
    filterApplied && base.length >= widened && enriched.length >= baseLimit;

  return NextResponse.json({
    data: enriched.slice(0, baseLimit),
    truncated: possiblyTruncated,
  });
}
