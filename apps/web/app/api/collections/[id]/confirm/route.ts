import { NextRequest, NextResponse } from "next/server";
import { requirePermissionWithBranchEnforced } from "@/lib/api/auth-helpers";
import { requireCollectionsTenant } from "@/lib/collections/flags";
import { decisionNoteSchema } from "@/lib/collections/schemas";
import {
  accessibleBranches,
  errorResponse,
  handleRouteError,
  invalidRequest,
  isUuid,
} from "@/lib/collections/route-helpers";
import { isOwner } from "@/lib/permissions";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import {
  IDEMPOTENCY_MISMATCH_BODY,
  lookupIdempotent,
  rememberResponse,
  requestFingerprint,
  validateIdempotencyKey,
} from "@/lib/api/idempotency";
import { logActivity } from "@/lib/repo/activity";
import { confirmCollection } from "@/lib/repo/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/collections/[id]/confirm {note?} (05 §4.3, §4.4; 03 §C.3).
//
// Enforced `confirm_collections` + four-eyes (nobody confirms a transfer they
// recorded; owners exempt → 403 SELF_CONFIRM_FORBIDDEN). Idempotency-Key is
// REQUIRED; the fingerprint binds {op, id, body} because the Redis key is
// (tenant, key) across every route. A retry after Redis lost the entry meets
// the repo's durable fallback (same user, < 24 h → 200 with the current DTO).

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermissionWithBranchEnforced("confirm_collections");
  if (!r.ok) return r.response;
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;
  const { id } = await params;
  if (!isUuid(id)) return errorResponse("COLLECTION_NOT_FOUND", 404);

  const body = await req.json().catch(() => ({}));
  const key = validateIdempotencyKey(req.headers.get("Idempotency-Key"));
  if (!key) return NextResponse.json({ error: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
  const fingerprint = requestFingerprint(r.ctx.userId, { op: "collection.confirm", id, body });
  const hit = await lookupIdempotent(r.ctx.tenantId, key, fingerprint);
  if (hit.kind === "mismatch") return NextResponse.json(IDEMPOTENCY_MISMATCH_BODY, { status: 409 });
  if (hit.kind === "replay") return NextResponse.json(hit.cached.body, { status: hit.cached.status });

  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  const parsed = decisionNoteSchema.safeParse(body ?? {});
  if (!parsed.success) return invalidRequest(parsed.error);

  try {
    const { dto, replayed } = await confirmCollection(
      r.ctx.tenantId,
      id,
      { userId: r.ctx.userId, isOwner: isOwner(r.ctx), accessibleBranchIds: accessibleBranches(r.ctx) },
      { note: parsed.data.note },
    );
    if (!replayed) {
      logActivity({
        tenantId: r.ctx.tenantId,
        actorUserId: r.ctx.userId,
        action: "collection.confirm",
        category: "collection",
        entityType: "collection",
        entityId: dto.id,
        entityLabel: dto.invoiceId,
        branchId: dto.branchId,
        metadata: { amount: dto.amount, invoiceId: dto.invoiceId, sourceType: dto.sourceType, method: dto.method },
      });
    }
    await rememberResponse(r.ctx.tenantId, key, 200, dto, fingerprint);
    return NextResponse.json(dto);
  } catch (err) {
    // Only a 2xx is remembered: a 409 / 403 is answered fresh on retry.
    return handleRouteError(err, "POST /api/collections/[id]/confirm");
  }
}
