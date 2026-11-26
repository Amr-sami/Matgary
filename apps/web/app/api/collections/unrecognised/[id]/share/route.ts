import { NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { requireCollectionsTenant } from "@/lib/collections/flags";
import { errorResponse, handleRouteError, isUuid } from "@/lib/collections/route-helpers";
import { isOwner } from "@/lib/permissions";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import { logActivity } from "@/lib/repo/activity";
import { shareUnrecognised } from "@/lib/repo/collection-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/collections/unrecognised/[id]/share (doc 15 spec 07 §4.5, §4.10).
// OWNER ONLY. "Send to TheStoro to add support": shared_at is set once
// (idempotent), retention becomes shared_at + 90 days, and spec 15's export
// script is the only reader of shared rows. Logs `collection.raw_share`.
// → 200 {id, sharedAt, expiresAt}.

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  if (!isOwner(r.ctx)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;
  const { id } = await params;
  if (!isUuid(id)) return errorResponse("NOT_FOUND", 404);
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  try {
    const out = await shareUnrecognised(r.ctx.tenantId, r.ctx.userId, id);
    if (out.firstShare) {
      logActivity({
        tenantId: r.ctx.tenantId,
        actorUserId: r.ctx.userId,
        action: "collection.raw_share",
        category: "collection",
        entityType: "collection_raw_message",
        entityId: out.id,
        metadata: { expiresAt: out.expiresAt },
      });
    }
    return NextResponse.json({ id: out.id, sharedAt: out.sharedAt, expiresAt: out.expiresAt });
  } catch (err) {
    return handleRouteError(err, "POST /api/collections/unrecognised/[id]/share");
  }
}
