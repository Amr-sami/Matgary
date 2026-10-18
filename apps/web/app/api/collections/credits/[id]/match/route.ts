import { NextRequest, NextResponse } from "next/server";
import { requirePermissionWithBranchEnforced } from "@/lib/api/auth-helpers";
import { requireCollectionsTenant } from "@/lib/collections/flags";
import { matchSchema } from "@/lib/collections/credit-schemas";
import { accessibleBranches, errorResponse, handleRouteError, invalidRequest, isUuid } from "@/lib/collections/route-helpers";
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
import { matchCredit } from "@/lib/repo/collection-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/collections/credits/[id]/match {collectionId} (doc 15 spec 07
// §4.5, §4.13). Enforced `confirm_collections` + four-eyes (nobody matches a
// credit to a collection they recorded; owners exempt → 403
// SELF_CONFIRM_FORBIDDEN, checked in matchCredit( via 05's
// assertNotSelfDecision). Idempotency-Key REQUIRED. A pending collection →
// confirmed; a confirmed one without a credit → the credit is attached as
// evidence. → 200 {credit, collection: {id, status}, warnings}.

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermissionWithBranchEnforced("confirm_collections");
  if (!r.ok) return r.response;
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;
  const { id } = await params;
  if (!isUuid(id)) return errorResponse("CREDIT_NOT_FOUND", 404);

  const body = await req.json().catch(() => ({}));
  const key = validateIdempotencyKey(req.headers.get("Idempotency-Key"));
  if (!key) return NextResponse.json({ error: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
  const fingerprint = requestFingerprint(r.ctx.userId, { op: "collection.credit_match", id, body });
  const hit = await lookupIdempotent(r.ctx.tenantId, key, fingerprint);
  if (hit.kind === "mismatch") return NextResponse.json(IDEMPOTENCY_MISMATCH_BODY, { status: 409 });
  if (hit.kind === "replay") return NextResponse.json(hit.cached.body, { status: hit.cached.status });

  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  const parsed = matchSchema.safeParse(body ?? {});
  if (!parsed.success) return invalidRequest(parsed.error);

  try {
    const out = await matchCredit(
      r.ctx.tenantId,
      { userId: r.ctx.userId, isOwner: isOwner(r.ctx), accessibleBranchIds: accessibleBranches(r.ctx) },
      id,
      parsed.data.collectionId,
    );
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "collection.credit_match",
      category: "collection",
      entityType: "collection",
      entityId: out.collection.id,
      branchId: out.credit.branchId,
      metadata: { creditId: out.credit.id, amount: out.credit.amount, warnings: out.warnings },
    });
    await rememberResponse(r.ctx.tenantId, key, 200, out, fingerprint);
    return NextResponse.json(out);
  } catch (err) {
    return handleRouteError(err, "POST /api/collections/credits/[id]/match");
  }
}
