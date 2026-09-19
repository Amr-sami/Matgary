// POST /api/whatsapp/templates/sync
//
// Owner-triggered full re-sync of message templates from Meta. Walks
// the WABA pagination and upserts; templates absent in the response
// are marked 'stale'. Rate-limited per (tenant, branch) so a stuck
// "Sync" button can't pummel Graph.

import { NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { rateLimit } from "@/lib/ratelimit";
import { syncTemplatesForBranch } from "@/lib/whatsapp/templates";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const SYNC_LIMIT = 6; // 6 syncs / 5 min — plenty for human use
const SYNC_WINDOW_SEC = 300;

export async function POST() {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth.response;
  if (auth.ctx.role !== "owner") {
    return NextResponse.json(
      { ok: false, error: "Owner role required" },
      { status: 403 },
    );
  }

  const limit = await rateLimit(
    "wa.templates.sync",
    `${auth.ctx.tenantId}:${auth.ctx.branchId}`,
    { limit: SYNC_LIMIT, windowSec: SYNC_WINDOW_SEC },
  );
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, error: "حاول بعد لحظات — حد المزامنة." },
      { status: 429 },
    );
  }

  logger.info({
    event: "wa.templates.sync.requested",
    tenantId: auth.ctx.tenantId,
    branchId: auth.ctx.branchId,
    userId: auth.ctx.userId,
  });

  const result = await syncTemplatesForBranch(
    auth.ctx.tenantId,
    auth.ctx.branchId,
  );

  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
