import { NextRequest, NextResponse } from "next/server";
import { requirePermissionWithBranchEnforced } from "@/lib/api/auth-helpers";
import { revokeReasonSchema } from "@/lib/collections/credit-schemas";
import { accessibleBranches, errorResponse, handleRouteError, isUuid } from "@/lib/collections/route-helpers";
import { isOwner } from "@/lib/permissions";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import { logActivity } from "@/lib/repo/activity";
import { revokeIngestDevice } from "@/lib/repo/collection-devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE /api/collections/devices/[id]?reason=owner|replaced (default owner)
// (doc 15 spec 07 §4.5, §4.4). Never flag-gated (D07-2, security). Deletes the
// device's raw messages in the same transaction and drops its cached token.
// Already revoked → 200 with the original revokedAt (the stored reason is not
// overwritten). `security` is operator-only → 400 INVALID_REQUEST.

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermissionWithBranchEnforced("manage_collection_accounts");
  if (!r.ok) return r.response;
  const { id } = await params;
  if (!isUuid(id)) return errorResponse("DEVICE_NOT_FOUND", 404);
  const reasonRaw = req.nextUrl.searchParams.get("reason") ?? "owner";
  const reason = revokeReasonSchema.safeParse(reasonRaw);
  if (!reason.success) return errorResponse("INVALID_REQUEST", 400, { path: "reason", message: "owner or replaced" });
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  try {
    const out = await revokeIngestDevice(
      {
        tenantId: r.ctx.tenantId,
        userId: r.ctx.userId,
        isOwner: isOwner(r.ctx),
        accessibleBranchIds: accessibleBranches(r.ctx),
      },
      id,
      reason.data,
    );
    if (!out.already) {
      logActivity({
        tenantId: r.ctx.tenantId,
        actorUserId: r.ctx.userId,
        action: "collection.device_revoke",
        category: "collection",
        entityType: "collection_device",
        entityId: id,
        entityLabel: out.device.label,
        branchId: out.device.branchId,
        metadata: { reason: reason.data, tokenPrefix: out.device.tokenPrefix },
      });
    }
    return NextResponse.json({ ok: true, revokedAt: out.revokedAt });
  } catch (err) {
    return handleRouteError(err, "DELETE /api/collections/devices/[id]");
  }
}
