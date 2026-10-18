import { NextRequest, NextResponse } from "next/server";
import { requirePermissionWithBranchEnforced } from "@/lib/api/auth-helpers";
import { resolveBranchFilter } from "@/lib/api/branch-context";
import { requireCollectionsTenant } from "@/lib/collections/flags";
import { errorResponse, handleRouteError, isUuid } from "@/lib/collections/route-helpers";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import { CREDITS_PAGE_MAX, listCredits } from "@/lib/repo/collection-credits";
import { CREDIT_STATE_VALUES, type CreditState } from "@matgary/domain/collections/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/collections/credits (doc 15 spec 07 §4.5; 03 §B.4, §B.17).
// Enforced `view_collections`. Readable while the ingest flag is off (D07-2:
// cleanup must stay possible). Query: state (comma list) · accountId ·
// branchId(|all) · from · to (ISO, on occurred_at) · cursor · limit (1..100,
// 50). A resolved branch shows `branch_id = b OR branch_id IS NULL`; test
// credits are never listed. → {data: CreditDTO[], nextCursor}.

function bad(path: string, message: string) {
  return errorResponse("INVALID_REQUEST", 400, { path, message });
}

export async function GET(req: NextRequest) {
  const r = await requirePermissionWithBranchEnforced("view_collections");
  if (!r.ok) return r.response;
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "list.default");
  if (!rl.ok) return rl.response;

  const q = req.nextUrl.searchParams;
  const filter = await resolveBranchFilter(r.ctx, q.get("branchId"));
  if (!filter.ok) return errorResponse(filter.error, filter.status);
  const states = (q.get("state") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of states) {
    if (!(CREDIT_STATE_VALUES as readonly string[]).includes(s)) return bad("state", `unknown state ${s}`);
  }
  const accountId = q.get("accountId");
  if (accountId && !isUuid(accountId)) return bad("accountId", "must be a uuid");
  const from = q.get("from");
  const to = q.get("to");
  if (from && Number.isNaN(Date.parse(from))) return bad("from", "must be an ISO date-time");
  if (to && Number.isNaN(Date.parse(to))) return bad("to", "must be an ISO date-time");
  const limitRaw = q.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > CREDITS_PAGE_MAX)) {
    return bad("limit", `must be 1..${CREDITS_PAGE_MAX}`);
  }

  try {
    const page = await listCredits(r.ctx.tenantId, {
      states: states as CreditState[],
      accountId: accountId ?? undefined,
      branchId: filter.branchId,
      from: from ?? undefined,
      to: to ?? undefined,
      cursor: q.get("cursor"),
      limit,
      viewerUserId: r.ctx.userId,
    });
    return NextResponse.json(page);
  } catch (err) {
    return handleRouteError(err, "GET /api/collections/credits");
  }
}
