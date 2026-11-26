import { NextRequest, NextResponse } from "next/server";
import { requirePermissionWithBranchEnforced } from "@/lib/api/auth-helpers";
import { requireCollectionsTenant } from "@/lib/collections/flags";
import { ignoreSchema } from "@/lib/collections/credit-schemas";
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
import { ignoreCredit } from "@/lib/repo/collection-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/collections/credits/[id]/ignore {reason, note?} (doc 15 spec 07
// §4.5, §4.13). Enforced `confirm_collections`; Idempotency-Key REQUIRED.
// From unmatched / held / info; matched → 409 CREDIT_ALREADY_MATCHED.
// `personal` / `not_a_sale` move the balance baseline forward (the money is
// real); `duplicate` / `other` never do. → 200 {credit}.

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
  const fingerprint = requestFingerprint(r.ctx.userId, { op: "collection.credit_ignore", id, body });
  const hit = await lookupIdempotent(r.ctx.tenantId, key, fingerprint);
  if (hit.kind === "mismatch") return NextResponse.json(IDEMPOTENCY_MISMATCH_BODY, { status: 409 });
  if (hit.kind === "replay") return NextResponse.json(hit.cached.body, { status: hit.cached.status });

  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  const parsed = ignoreSchema.safeParse(body ?? {});
  if (!parsed.success) return invalidRequest(parsed.error);

  try {
    const credit = await ignoreCredit(
      r.ctx.tenantId,
      { userId: r.ctx.userId, isOwner: isOwner(r.ctx), accessibleBranchIds: accessibleBranches(r.ctx) },
      id,
      { reason: parsed.data.reason, note: parsed.data.note ?? null },
    );
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "collection.credit_ignore",
      category: "collection",
      entityType: "collection_credit",
      entityId: credit.id,
      branchId: credit.branchId,
      metadata: { reason: parsed.data.reason, amount: credit.amount, ...(parsed.data.note ? { note: parsed.data.note } : {}) },
    });
    const out = { credit };
    await rememberResponse(r.ctx.tenantId, key, 200, out, fingerprint);
    return NextResponse.json(out);
  } catch (err) {
    return handleRouteError(err, "POST /api/collections/credits/[id]/ignore");
  }
}
