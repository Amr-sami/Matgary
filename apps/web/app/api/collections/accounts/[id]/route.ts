import { NextRequest, NextResponse } from "next/server";
import { requirePermissionWithBranchEnforced } from "@/lib/api/auth-helpers";
import { requireCollectionsTenant } from "@/lib/collections/flags";
import { accountPatchSchema } from "@/lib/collections/schemas";
import {
  accessibleBranches,
  errorResponse,
  handleRouteError,
  invalidRequest,
  isUuid,
} from "@/lib/collections/route-helpers";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import { logActivity } from "@/lib/repo/activity";
import {
  accountActivityMetadata,
  archiveCollectionAccount,
  updateCollectionAccount,
} from "@/lib/repo/collection-accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Digital collections — one receiving account (05 §4.14).
// PATCH: every create field except rail / provider; changing the wallet
// number or the account's last 4 restarts 07's balance chain.
// DELETE: archive (there is no hard delete: collections reference it).
// Archived, foreign, out-of-reach or non-uuid ids → 404.

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermissionWithBranchEnforced("manage_collection_accounts");
  if (!r.ok) return r.response;
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;
  const { id } = await params;
  if (!isUuid(id)) return errorResponse("COLLECTION_ACCOUNT_NOT_FOUND", 404);

  const body = await req.json().catch(() => null);
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  const parsed = accountPatchSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);

  try {
    const { dto, changed } = await updateCollectionAccount(
      r.ctx.tenantId,
      {
        userId: r.ctx.userId,
        isOwner: r.ctx.role === "owner",
        activeBranchId: r.ctx.branchId,
        accessibleBranchIds: accessibleBranches(r.ctx),
      },
      id,
      parsed.data,
    );
    if (changed.length > 0) {
      logActivity({
        tenantId: r.ctx.tenantId,
        actorUserId: r.ctx.userId,
        action: "collection.account_update",
        category: "collection",
        entityType: "collection_account",
        entityId: dto.id,
        entityLabel: dto.label,
        branchId: r.ctx.branchId,
        // Field names only — never the IBAN digits.
        metadata: { ...accountActivityMetadata(dto), changed },
      });
    }
    return NextResponse.json(dto);
  } catch (err) {
    return handleRouteError(err, "PATCH /api/collections/accounts/[id]");
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermissionWithBranchEnforced("manage_collection_accounts");
  if (!r.ok) return r.response;
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;
  const { id } = await params;
  if (!isUuid(id)) return errorResponse("COLLECTION_ACCOUNT_NOT_FOUND", 404);
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;

  try {
    const res = await archiveCollectionAccount(
      r.ctx.tenantId,
      {
        userId: r.ctx.userId,
        isOwner: r.ctx.role === "owner",
        activeBranchId: r.ctx.branchId,
        accessibleBranchIds: accessibleBranches(r.ctx),
      },
      id,
    );
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "collection.account_archive",
      category: "collection",
      entityType: "collection_account",
      entityId: id,
      entityLabel: res.label,
      branchId: r.ctx.branchId,
      metadata: { last4: res.accountLast4, pendingCollections: res.pendingCollections },
    });
    return NextResponse.json({ archived: true, pendingCollections: res.pendingCollections });
  } catch (err) {
    return handleRouteError(err, "DELETE /api/collections/accounts/[id]");
  }
}
