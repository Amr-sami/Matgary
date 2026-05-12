// POST /api/whatsapp/connection/healthcheck
//
// Manual "run check" trigger from the settings UI. Throttled per (tenant,
// branch) to once every 30s so a stuck "refresh" button can't pummel
// Graph. Phase 3+ will run this on a schedule via BullMQ.

import { NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { rateLimit } from "@/lib/ratelimit";
import { runHealthCheck } from "@/lib/whatsapp/health";

export const runtime = "nodejs";

const HEALTH_LIMIT = 4; // 4 runs / 30s window per branch — generous for human use
const HEALTH_WINDOW_SEC = 30;

export async function POST() {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth.response;

  const limit = await rateLimit(
    "wa.healthcheck",
    `${auth.ctx.tenantId}:${auth.ctx.branchId}`,
    { limit: HEALTH_LIMIT, windowSec: HEALTH_WINDOW_SEC },
  );
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, error: "حاول بعد لحظات — حد فحص الاتصال." },
      { status: 429 },
    );
  }

  const result = await runHealthCheck(auth.ctx.tenantId, auth.ctx.branchId);
  // Echo the actionable fields — never the raw connection object (it
  // could carry sensitive bits from raw_metadata down the line).
  return NextResponse.json({
    ok: result.ok,
    errorState: result.errorState,
    note: result.note,
    details: result.details,
    needsReauth: result.needsReauth,
  });
}
