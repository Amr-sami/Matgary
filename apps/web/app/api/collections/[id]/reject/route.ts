import { NextRequest, NextResponse } from "next/server";
import { requirePermissionWithBranchEnforced } from "@/lib/api/auth-helpers";
import { requireCollectionsTenant } from "@/lib/collections/flags";
import { rejectSchema } from "@/lib/collections/schemas";
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
import { rejectCollection } from "@/lib/repo/collections";
import { normalizeEgyptPhone } from "@/lib/validators/egypt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/collections/[id]/reject {reason, outcome?, customerPhone?, note?}
// (05 §4.10, Q4; 03 §C.4).
//
// Sale: `debt` (the default when the sale has, or the body gives, a customer
// phone) turns the invoice lines into unpaid `deferred` customer debt;
// `loss` leaves the lines as taken and books the loss against the recording
// cashier. `debt` with no phone anywhere → 400 REJECT_OUTCOME_REQUIRES_PHONE.
// Settlement: always `debt` — its sale_payments rows are voided and the debt
// comes back. The previous line states go into the `rejected` event, the
// owner's reopen input. Enforced `confirm_collections` + four-eyes;
// Idempotency-Key required.

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermissionWithBranchEnforced("confirm_collections");
  if (!r.ok) return r.response;
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;
  const { id } = await params;
  if (!isUuid(id)) return errorResponse("COLLECTION_NOT_FOUND", 404);

  const body = await req.json().catch(() => null);
  const key = validateIdempotencyKey(req.headers.get("Idempotency-Key"));
  if (!key) return NextResponse.json({ error: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
  const fingerprint = requestFingerprint(r.ctx.userId, { op: "collection.reject", id, body });
  const hit = await lookupIdempotent(r.ctx.tenantId, key, fingerprint);
  if (hit.kind === "mismatch") return NextResponse.json(IDEMPOTENCY_MISMATCH_BODY, { status: 409 });
  if (hit.kind === "replay") return NextResponse.json(hit.cached.body, { status: hit.cached.status });

  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  const parsed = rejectSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);

  let customerPhone: string | null = null;
  if (parsed.data.customerPhone && parsed.data.customerPhone.trim() !== "") {
    customerPhone = normalizeEgyptPhone(parsed.data.customerPhone);
    if (!customerPhone) return NextResponse.json({ error: "INVALID_PHONE" }, { status: 400 });
  }

  try {
    const { dto, replayed, outcome } = await rejectCollection(
      r.ctx.tenantId,
      id,
      { userId: r.ctx.userId, isOwner: isOwner(r.ctx), accessibleBranchIds: accessibleBranches(r.ctx) },
      {
        reason: parsed.data.reason,
        outcome: parsed.data.outcome,
        customerPhone,
        note: parsed.data.note,
      },
    );
    if (!replayed) {
      logActivity({
        tenantId: r.ctx.tenantId,
        actorUserId: r.ctx.userId,
        action: "collection.reject",
        category: "collection",
        entityType: "collection",
        entityId: dto.id,
        entityLabel: dto.invoiceId,
        branchId: dto.branchId,
        metadata: {
          reason: parsed.data.reason,
          outcome,
          amount: dto.amount,
          invoiceId: dto.invoiceId,
          sourceType: dto.sourceType,
        },
      });
    }
    await rememberResponse(r.ctx.tenantId, key, 200, dto, fingerprint);
    return NextResponse.json(dto);
  } catch (err) {
    return handleRouteError(err, "POST /api/collections/[id]/reject");
  }
}
