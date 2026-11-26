import { NextRequest, NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { resolveBranchFilter } from "@/lib/api/branch-context";
import { requireCollectionsTenant } from "@/lib/collections/flags";
import { SOURCE_TYPES } from "@/lib/collections/schemas";
import { errorResponse, handleRouteError, isUuid } from "@/lib/collections/route-helpers";
import { can } from "@/lib/permissions";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import { listCollections, COLLECTIONS_PAGE_MAX } from "@/lib/repo/collections";
import {
  COLLECTION_STATUS_VALUES,
  type CollectionSourceType,
  type CollectionStatus,
} from "@matgary/domain/collections/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/collections — the Collections inbox (05 §4.3, §4.13; 03 §B.4).
//
// `view_collections` (enforced `can`, never the audited helper) sees the
// branch's items; `?branchId=all` is owner-only. A cashier with only
// `record_sales` is never refused: they get their OWN rows
// (recorded_by_user_id = self), so the POS can show "awaiting confirmation"
// on what they rang up. Neither key → 403 Forbidden.
//
// Query: status (comma list) · accountId · sourceType · branchId(|all) ·
// from · to (ISO, on rung_at) · stale=1 · invoiceId · order=asc|desc ·
// cursor · limit (1..100, default 50).
// → { data: CollectionDTO[], nextCursor, counts: { pending, stale } }

function bad(path: string, message: string) {
  return errorResponse("INVALID_REQUEST", 400, { path, message });
}

export async function GET(req: NextRequest) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;

  const canView = can(r.ctx, "view_collections");
  const ownOnly = !canView && can(r.ctx, "record_sales");
  if (!canView && !ownOnly) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rl = await checkTenantRateLimit(r.ctx.tenantId, "list.default");
  if (!rl.ok) return rl.response;

  const q = req.nextUrl.searchParams;
  const filter = await resolveBranchFilter(r.ctx, q.get("branchId"));
  if (!filter.ok) return errorResponse(filter.error, filter.status);

  const statusRaw = q.get("status");
  const statuses = statusRaw
    ? statusRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  for (const s of statuses) {
    if (!(COLLECTION_STATUS_VALUES as readonly string[]).includes(s)) return bad("status", `unknown status ${s}`);
  }
  const accountId = q.get("accountId");
  if (accountId && !isUuid(accountId)) return bad("accountId", "must be a uuid");
  const sourceType = q.get("sourceType");
  if (sourceType && !(SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    return bad("sourceType", "must be sale or settlement");
  }
  const from = q.get("from");
  const to = q.get("to");
  if (from && Number.isNaN(Date.parse(from))) return bad("from", "must be an ISO date-time");
  if (to && Number.isNaN(Date.parse(to))) return bad("to", "must be an ISO date-time");
  const order = q.get("order");
  if (order && order !== "asc" && order !== "desc") return bad("order", "must be asc or desc");
  const limitRaw = q.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > COLLECTIONS_PAGE_MAX)) {
    return bad("limit", `must be 1..${COLLECTIONS_PAGE_MAX}`);
  }
  const invoiceId = q.get("invoiceId");
  if (invoiceId && invoiceId.length > 80) return bad("invoiceId", "too long");

  try {
    const page = await listCollections(r.ctx.tenantId, {
      statuses: statuses as CollectionStatus[],
      accountId: accountId ?? undefined,
      sourceType: (sourceType as CollectionSourceType | null) ?? undefined,
      branchId: filter.branchId,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
      stale: q.get("stale") === "1",
      invoiceId: invoiceId ?? undefined,
      order: order === "asc" ? "asc" : "desc",
      cursor: q.get("cursor"),
      limit,
      recordedByUserId: ownOnly ? r.ctx.userId : undefined,
    });
    return NextResponse.json(page);
  } catch (err) {
    return handleRouteError(err, "GET /api/collections");
  }
}
