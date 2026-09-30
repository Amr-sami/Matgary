import { NextRequest, NextResponse } from "next/server";
import {
  requirePermissionWithBranchEnforced,
  requireTenantWithBranch,
} from "@/lib/api/auth-helpers";
import { resolveBranchFilter } from "@/lib/api/branch-context";
import { requireCollectionsTenant } from "@/lib/collections/flags";
import { settingsPatchSchema } from "@/lib/collections/schemas";
import { errorResponse, handleRouteError, invalidRequest } from "@/lib/collections/route-helpers";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import { logActivity } from "@/lib/repo/activity";
import { getCollectionSettings, saveCollectionSettings } from "@/lib/repo/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET / PATCH /api/collections/settings?branchId= (05 §4.13).
// The five per-branch switches in shop_settings: collectionsEnabled (the
// branch switch of features.collections), collectionsRequireAccount,
// collectionsStaleAfterMinutes (15..1440, Q15), collectionsAutoConfirmEnabled,
// collectionsStorePayerNames (Q18). Branch = the active one, or ?branchId=
// (a branch the caller can reach; the owner may name any). GET: any member.
// PATCH: enforced `manage_collection_accounts` (not manage_whatsapp).

/** The settings branch: `?branchId=` (never "all") or the active branch. */
async function settingsBranch(
  ctx: Parameters<typeof resolveBranchFilter>[0],
  raw: string | null,
): Promise<{ ok: true; branchId: string } | { ok: false; response: NextResponse }> {
  if (raw === "all") {
    return { ok: false, response: errorResponse("INVALID_REQUEST", 400, { path: "branchId", message: "one branch" }) };
  }
  const f = await resolveBranchFilter(ctx, raw);
  if (!f.ok) return { ok: false, response: errorResponse(f.error, f.status) };
  return { ok: true, branchId: f.branchId! };
}

export async function GET(req: NextRequest) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "list.default");
  if (!rl.ok) return rl.response;
  const b = await settingsBranch(r.ctx, req.nextUrl.searchParams.get("branchId"));
  if (!b.ok) return b.response;
  try {
    return NextResponse.json(await getCollectionSettings(r.ctx.tenantId, b.branchId));
  } catch (err) {
    return handleRouteError(err, "GET /api/collections/settings");
  }
}

export async function PATCH(req: NextRequest) {
  const r = await requirePermissionWithBranchEnforced("manage_collection_accounts");
  if (!r.ok) return r.response;
  const off = requireCollectionsTenant(r.ctx.tenantId);
  if (off) return off;
  const body = await req.json().catch(() => null);
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  const parsed = settingsPatchSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  const b = await settingsBranch(r.ctx, req.nextUrl.searchParams.get("branchId"));
  if (!b.ok) return b.response;

  try {
    const { settings, changed } = await saveCollectionSettings(r.ctx.tenantId, b.branchId, parsed.data);
    if (changed.length > 0) {
      logActivity({
        tenantId: r.ctx.tenantId,
        actorUserId: r.ctx.userId,
        action: "collection.settings_update",
        category: "collection",
        // No entity row: the switches live on the branch's shop_settings.
        entityType: null,
        entityId: null,
        branchId: b.branchId,
        metadata: { changed, ...Object.fromEntries(changed.map((k) => [k, settings[k as keyof typeof settings]])) },
      });
    }
    return NextResponse.json(settings);
  } catch (err) {
    return handleRouteError(err, "PATCH /api/collections/settings");
  }
}
