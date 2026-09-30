import { NextRequest, NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { requireCollectionsTenant } from "@/lib/collections/flags";
import { collectionPatchSchema } from "@/lib/collections/schemas";
import {
  accessibleBranches,
  errorResponse,
  handleRouteError,
  invalidRequest,
  isUuid,
} from "@/lib/collections/route-helpers";
import { can, isOwner } from "@/lib/permissions";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import {
  getCollection,
  getCollectionHead,
  updatePendingCollection,
} from "@/lib/repo/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET / PATCH /api/collections/[id] (05 §4.3, §4.13).
//
// GET: `view_collections`, or a cashier (`record_sales`) reading a collection
// they recorded; otherwise 403. A collection outside the caller's branches,
// or a non-uuid id, answers 404 COLLECTION_NOT_FOUND (ids cannot be probed).
// The event trail's line snapshots are the owner's reopen input and are
// stripped for everyone else.
//
// PATCH (pending only): the account and the payer hints — by the recorder
// (`record_sales`) or by someone holding `confirm_collections`.

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;

  const canView = can(r.ctx, "view_collections");
  const canRecord = can(r.ctx, "record_sales");
  if (!canView && !canRecord) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  if (!isUuid(id)) return errorResponse("COLLECTION_NOT_FOUND", 404);
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "list.default");
  if (!rl.ok) return rl.response;

  try {
    const access = { accessibleBranchIds: accessibleBranches(r.ctx) };
    if (!canView) {
      // Cashier path: only a collection they recorded.
      const head = await getCollectionHead(r.ctx.tenantId, id, access);
      if (!head) return errorResponse("COLLECTION_NOT_FOUND", 404);
      if (head.recordedByUserId !== r.ctx.userId) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }
    const dto = await getCollection(r.ctx.tenantId, id, { ...access, includeSnapshots: isOwner(r.ctx) });
    if (!dto) return errorResponse("COLLECTION_NOT_FOUND", 404);
    return NextResponse.json(dto);
  } catch (err) {
    return handleRouteError(err, "GET /api/collections/[id]");
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;

  const canDecide = can(r.ctx, "confirm_collections");
  const canRecord = can(r.ctx, "record_sales");
  if (!canDecide && !canRecord) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  if (!isUuid(id)) return errorResponse("COLLECTION_NOT_FOUND", 404);
  const body = await req.json().catch(() => null);
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  const parsed = collectionPatchSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);

  try {
    const { dto } = await updatePendingCollection(
      r.ctx.tenantId,
      id,
      {
        userId: r.ctx.userId,
        isOwner: isOwner(r.ctx),
        accessibleBranchIds: accessibleBranches(r.ctx),
        // Without confirm_collections, only the recorder may edit (the
        // repo answers 403 Forbidden otherwise).
        mustBeRecorder: !canDecide,
      },
      parsed.data,
    );
    return NextResponse.json(dto);
  } catch (err) {
    return handleRouteError(err, "PATCH /api/collections/[id]");
  }
}
