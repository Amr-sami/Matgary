import { NextRequest, NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
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
import { reopenCollection } from "@/lib/repo/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/collections/[id]/reopen {note?} (05 §4.11).
//
// Owner only, ≤ 7 days after the decision (409 REOPEN_WINDOW_CLOSED).
// A rejection is reversed from its snapshot, unless the invoice moved since
// (a settle, mark-all-paid, edit or second rejection) → 409
// REOPEN_BLOCKED_SETTLED with detail.reason payment_after_reject |
// lines_changed. Idempotency-Key required.

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  if (!isOwner(r.ctx)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;
  const { id } = await params;
  if (!isUuid(id)) return errorResponse("COLLECTION_NOT_FOUND", 404);

  const body = await req.json().catch(() => ({}));
  const key = validateIdempotencyKey(req.headers.get("Idempotency-Key"));
  if (!key) return NextResponse.json({ error: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
  const fingerprint = requestFingerprint(r.ctx.userId, { op: "collection.reopen", id, body });
  const hit = await lookupIdempotent(r.ctx.tenantId, key, fingerprint);
  if (hit.kind === "mismatch") return NextResponse.json(IDEMPOTENCY_MISMATCH_BODY, { status: 409 });
  if (hit.kind === "replay") return NextResponse.json(hit.cached.body, { status: hit.cached.status });

  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  const parsed = decisionNoteSchema.safeParse(body ?? {});
  if (!parsed.success) return invalidRequest(parsed.error);

  try {
    const { dto, replayed, fromStatus } = await reopenCollection(
      r.ctx.tenantId,
      id,
      { userId: r.ctx.userId, isOwner: true, accessibleBranchIds: accessibleBranches(r.ctx) },
      { note: parsed.data.note },
    );
    if (!replayed) {
      logActivity({
        tenantId: r.ctx.tenantId,
        actorUserId: r.ctx.userId,
        action: "collection.reopen",
        category: "collection",
        entityType: "collection",
        entityId: dto.id,
        entityLabel: dto.invoiceId,
        branchId: dto.branchId,
        metadata: { fromStatus, amount: dto.amount, invoiceId: dto.invoiceId, sourceType: dto.sourceType },
      });
    }
    await rememberResponse(r.ctx.tenantId, key, 200, dto, fingerprint);
    return NextResponse.json(dto);
  } catch (err) {
    return handleRouteError(err, "POST /api/collections/[id]/reopen");
  }
}
