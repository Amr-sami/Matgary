import { NextRequest, NextResponse } from "next/server";
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
import { collectionsIngestConfigFields } from "@/lib/repo/collection-devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/collections/config — CollectionsConfigDTO (03 §B.17, 05 §4.13).
// Deliberately NOT behind requireCollectionsTenant: it is how clients learn
// the flags, so a tenant the env gate does not admit gets 200 with every
// feature false. `ingest` (spec 07, M2) is null unless
// features.collectionsIngest: the ingest / heartbeat / config URLs (absolute,
// from appOrigin), the four iOS shortcut links (env, empty → null), the
// device ceiling, the live count and PLATFORM_CHANNELS.

// `req` is optional only so 05's unit test can call GET() bare; Next always passes it.
export async function GET(req?: NextRequest) {
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
      ingest: req ? await collectionsIngestConfigFields(r.ctx, req, features) : null,
    });
  } catch (err) {
    return handleRouteError(err, "GET /api/collections/config");
  }
}
