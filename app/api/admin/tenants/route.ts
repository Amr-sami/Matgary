import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import {
  listTenants,
  type TenantListFilters,
  type TenantStatus,
} from "@/lib/admin/tenants";

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

function asStatus(s: string | null): TenantStatus | undefined {
  if (!s) return undefined;
  return (STATUS_VALUES as string[]).includes(s) ? (s as TenantStatus) : undefined;
}

export async function GET(req: NextRequest) {
  const r = await requirePermission("tenant.read");
  if (!r.ok) return r.response;

  const sp = req.nextUrl.searchParams;
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
    limit: sp.get("limit") ? Math.min(200, Math.max(1, Number(sp.get("limit")))) : undefined,
    offset: sp.get("offset") ? Math.max(0, Number(sp.get("offset"))) : undefined,
  };

  const data = await listTenants(filters);
  return NextResponse.json({ data });
}
