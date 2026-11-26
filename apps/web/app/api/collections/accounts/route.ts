import { NextRequest, NextResponse } from "next/server";
import {
  requirePermissionWithBranchEnforced,
  requireTenantWithBranch,
} from "@/lib/api/auth-helpers";
import { requireCollectionsTenant } from "@/lib/collections/flags";
import { accountCreateSchema } from "@/lib/collections/schemas";
import { accessibleBranches, handleRouteError, invalidRequest } from "@/lib/collections/route-helpers";
import { can } from "@/lib/permissions";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import {
  IDEMPOTENCY_MISMATCH_BODY,
  lookupIdempotent,
  rememberResponse,
  requestFingerprint,
  validateIdempotencyKey,
} from "@/lib/api/idempotency";
import { logActivity } from "@/lib/repo/activity";
import {
  accountActivityMetadata,
  createCollectionAccount,
  listCollectionAccounts,
} from "@/lib/repo/collection-accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Digital collections — receiving accounts (05 §4.3, §4.14; 03 §B.4).
//
// GET: any member — a cashier must show the customer the shop's InstaPay QR
// or wallet number. `manage_collection_accounts` additionally gets the full
// IBAN, the balance-chain fields, archived rows and `?scope=all`.
// POST: enforced `manage_collection_accounts` (403 whatever
// PERMISSION_ENFORCE_WRITES says); optional Idempotency-Key (Redis only).

export async function GET(req: NextRequest) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "list.default");
  if (!rl.ok) return rl.response;

  const canManage = can(r.ctx, "manage_collection_accounts");
  const q = req.nextUrl.searchParams;
  try {
    const data = await listCollectionAccounts(r.ctx.tenantId, {
      activeBranchId: r.ctx.branchId,
      scope: q.get("scope") === "all" ? "all" : "branch",
      includeArchived: q.get("includeArchived") === "1",
      canManage,
      accessibleBranchIds: accessibleBranches(r.ctx),
    });
    return NextResponse.json({ data, branchId: r.ctx.branchId });
  } catch (err) {
    return handleRouteError(err, "GET /api/collections/accounts");
  }
}

export async function POST(req: NextRequest) {
  const r = await requirePermissionWithBranchEnforced("manage_collection_accounts");
  if (!r.ok) return r.response;
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;

  const body = await req.json().catch(() => null);
  const idemp = validateIdempotencyKey(req.headers.get("Idempotency-Key"));
  const fingerprint = idemp
    ? requestFingerprint(r.ctx.userId, { op: "collection.account_create", body })
    : null;
  if (idemp && fingerprint) {
    const hit = await lookupIdempotent(r.ctx.tenantId, idemp, fingerprint);
    if (hit.kind === "mismatch") return NextResponse.json(IDEMPOTENCY_MISMATCH_BODY, { status: 409 });
    if (hit.kind === "replay") return NextResponse.json(hit.cached.body, { status: hit.cached.status });
  }

  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;

  const parsed = accountCreateSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);

  try {
    const dto = await createCollectionAccount(
      r.ctx.tenantId,
      {
        userId: r.ctx.userId,
        isOwner: r.ctx.role === "owner",
        activeBranchId: r.ctx.branchId,
        accessibleBranchIds: accessibleBranches(r.ctx),
      },
      parsed.data,
    );
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "collection.account_create",
      category: "collection",
      entityType: "collection_account",
      entityId: dto.id,
      entityLabel: dto.label,
      branchId: r.ctx.branchId,
      metadata: accountActivityMetadata(dto),
    });
    if (idemp && fingerprint) {
      await rememberResponse(r.ctx.tenantId, idemp, 201, dto, fingerprint);
    }
    return NextResponse.json(dto, { status: 201 });
  } catch (err) {
    return handleRouteError(err, "POST /api/collections/accounts");
  }
}
