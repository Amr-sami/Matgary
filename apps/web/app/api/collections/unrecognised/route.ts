import { NextRequest, NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { requireCollectionsTenant } from "@/lib/collections/flags";
import { errorResponse, handleRouteError } from "@/lib/collections/route-helpers";
import { isOwner } from "@/lib/permissions";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import { logActivity } from "@/lib/repo/activity";
import { CREDITS_PAGE_MAX, listUnrecognised } from "@/lib/repo/collection-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/collections/unrecognised?cursor&limit (doc 15 spec 07 §4.5,
// §4.10; 03 §D.6, §E.5). OWNER ONLY: the decrypted text of forwarded messages
// whose format is unknown (or matched only the fallback). Every page served
// logs one `collection.raw_view` (count + ids, never text).
// → {data: UnrecognisedDTO[], nextCursor}.

export async function GET(req: NextRequest) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  if (!isOwner(r.ctx)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "list.default");
  if (!rl.ok) return rl.response;
  const q = req.nextUrl.searchParams;
  const limitRaw = q.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > CREDITS_PAGE_MAX)) {
    return errorResponse("INVALID_REQUEST", 400, { path: "limit", message: `must be 1..${CREDITS_PAGE_MAX}` });
  }
  try {
    const page = await listUnrecognised(r.ctx.tenantId, { cursor: q.get("cursor"), limit });
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "collection.raw_view",
      category: "collection",
      entityType: "collection_device",
      entityId: page.data[0]?.device?.id ?? null,
      metadata: { count: page.data.length, ids: page.data.map((d) => d.id) },
    });
    return NextResponse.json(page);
  } catch (err) {
    return handleRouteError(err, "GET /api/collections/unrecognised");
  }
}
