import { NextRequest, NextResponse } from "next/server";
import { requirePermissionWithBranchEnforced } from "@/lib/api/auth-helpers";
import { requireCollectionsTenant } from "@/lib/collections/flags";
import { accessibleBranches, errorResponse, handleRouteError, isUuid } from "@/lib/collections/route-helpers";
import { isOwner } from "@/lib/permissions";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import { logActivity } from "@/lib/repo/activity";
import { getCredit } from "@/lib/repo/collection-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/collections/credits/[id] → CreditDetailDTO with ≤ 10 ranked
// candidates (doc 15 spec 07 §4.5). Enforced `view_collections`.
// `?includeRaw=1` adds the decrypted message for the OWNER only (others get
// raw: null) and logs one `collection.raw_view` (never the text).

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermissionWithBranchEnforced("view_collections");
  if (!r.ok) return r.response;
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;
  const { id } = await params;
  if (!isUuid(id)) return errorResponse("CREDIT_NOT_FOUND", 404);
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "list.default");
  if (!rl.ok) return rl.response;
  const owner = isOwner(r.ctx);
  const includeRaw = owner && req.nextUrl.searchParams.get("includeRaw") === "1";
  try {
    const dto = await getCredit(r.ctx.tenantId, id, {
      accessibleBranchIds: accessibleBranches(r.ctx),
      userId: r.ctx.userId,
      includeRaw,
    });
    if (!dto) return errorResponse("CREDIT_NOT_FOUND", 404);
    if (includeRaw && dto.raw) {
      logActivity({
        tenantId: r.ctx.tenantId,
        actorUserId: r.ctx.userId,
        action: "collection.raw_view",
        category: "collection",
        entityType: "collection_device",
        entityId: dto.device?.id ?? null,
        branchId: dto.branchId,
        metadata: { count: 1, creditIds: [dto.id] },
      });
    }
    return NextResponse.json(dto);
  } catch (err) {
    return handleRouteError(err, "GET /api/collections/credits/[id]");
  }
}
