import { NextRequest, NextResponse } from "next/server";
import { requirePermissionWithBranchEnforced } from "@/lib/api/auth-helpers";
import { resolveCollectionsFeatures } from "@/lib/collections/flags";
import { pasteSchema } from "@/lib/collections/credit-schemas";
import { accessibleBranches, errorResponse, handleRouteError, invalidRequest } from "@/lib/collections/route-helpers";
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
import { pasteCredits } from "@/lib/repo/collection-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/collections/credits/paste {text, sender?, accountId?} (doc 15
// spec 07 §4.5, §4.13). Enforced `confirm_collections`, gated by
// features.collectionsIngest; Idempotency-Key REQUIRED. The text splits on
// blank lines (≤ 20 pieces, else 413); each piece runs the ingest pipeline as
// channel `manual_paste`. A paste NEVER auto-confirms (`manual_source`) and
// never notifies; a copy of a credit already on file answers `duplicate`
// with its creditId. → 200 {results: PasteResult[]}.

export async function POST(req: NextRequest) {
  const r = await requirePermissionWithBranchEnforced("confirm_collections");
  if (!r.ok) return r.response;
  const features = await resolveCollectionsFeatures(r.ctx.tenantId, r.ctx.branchId);
  if (!features.collections) return errorResponse("COLLECTIONS_DISABLED", 403);
  if (!features.collectionsIngest) return errorResponse("INGEST_DISABLED", 403);

  const body = await req.json().catch(() => ({}));
  const key = validateIdempotencyKey(req.headers.get("Idempotency-Key"));
  if (!key) return NextResponse.json({ error: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
  const fingerprint = requestFingerprint(r.ctx.userId, { op: "collection.credit_paste", body });
  const hit = await lookupIdempotent(r.ctx.tenantId, key, fingerprint);
  if (hit.kind === "mismatch") return NextResponse.json(IDEMPOTENCY_MISMATCH_BODY, { status: 409 });
  if (hit.kind === "replay") return NextResponse.json(hit.cached.body, { status: hit.cached.status });

  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  const parsed = pasteSchema.safeParse(body ?? {});
  if (!parsed.success) return invalidRequest(parsed.error);

  try {
    const out = await pasteCredits(
      r.ctx.tenantId,
      { userId: r.ctx.userId, isOwner: isOwner(r.ctx), accessibleBranchIds: accessibleBranches(r.ctx) },
      { text: parsed.data.text, sender: parsed.data.sender ?? null, accountId: parsed.data.accountId ?? null },
    );
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "collection.credit_paste",
      category: "collection",
      entityType: "collection_credit",
      branchId: r.ctx.branchId,
      metadata: { count: out.results.length, accepted: out.accepted },
    });
    const res = { results: out.results };
    await rememberResponse(r.ctx.tenantId, key, 200, res, fingerprint);
    return NextResponse.json(res);
  } catch (err) {
    return handleRouteError(err, "POST /api/collections/credits/paste");
  }
}
