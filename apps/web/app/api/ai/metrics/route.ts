import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/api/auth-helpers";
import { metrics } from "@/lib/ai/telemetry";

/**
 * F8 — In-memory AI metrics snapshot.
 *
 * Owner / view_insights only. Exposes process-local counters + latency
 * percentiles for operational dashboards. These reset on process restart;
 * that's acceptable per the F8 scope ("expose structured metrics/logs in a
 * way that a future dashboard can consume" — not build the dashboard).
 *
 * NO secrets, NO per-request details, NO tenant disaggregation. Dashboard
 * consumers that need per-tenant views should read the structured `[ai/run]`
 * log lines instead.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await requirePermission("view_insights");
  if (!r.ok) return r.response;

  const snap = metrics.snapshot();
  return NextResponse.json({
    ...snap,
    emittedAt: new Date().toISOString(),
  });
}
