import { NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { resolveCollectionsFeatures } from "@/lib/collections/flags";
import { MAX_COLLECTION_PARTS } from "@/lib/collections/math";
import { handleRouteError } from "@/lib/collections/route-helpers";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import {
  getCollectionSettings,
  NOTE_MAX_LENGTH,
  REOPEN_DAYS,
} from "@/lib/repo/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/collections/config — CollectionsConfigDTO (03 §B.17, 05 §4.13).
// Deliberately NOT behind requireCollectionsTenant: it is how clients learn
// the flags, so a tenant the env gate does not admit gets 200 with every
// feature false. `ingest` is null in M1; spec 07 fills that block at M2.

export async function GET() {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "list.default");
  if (!rl.ok) return rl.response;
  try {
    const [features, settings] = await Promise.all([
      resolveCollectionsFeatures(r.ctx.tenantId, r.ctx.branchId),
      getCollectionSettings(r.ctx.tenantId, r.ctx.branchId),
    ]);
    return NextResponse.json({
      features,
      branchId: r.ctx.branchId,
      requireAccount: settings.collectionsRequireAccount,
      staleAfterMinutes: settings.collectionsStaleAfterMinutes,
      limits: { maxParts: MAX_COLLECTION_PARTS, reopenDays: REOPEN_DAYS, noteMaxLength: NOTE_MAX_LENGTH },
      ingest: null,
    });
  } catch (err) {
    return handleRouteError(err, "GET /api/collections/config");
  }
}
