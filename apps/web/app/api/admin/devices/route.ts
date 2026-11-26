// GET /api/admin/devices
// Platform-wide install + device analytics: installs today/week/month,
// active devices now/today, platform split, 90-day install trend, and the
// top 20 (platform, app_version) buckets across devices used in the last
// 30 days. Exact counts, no sampling.

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import { getDeviceAnalytics } from "@/lib/admin/presence-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await requirePermission("tenant.read");
  if (!r.ok) return r.response;
  const analytics = await getDeviceAnalytics();
  return NextResponse.json(analytics);
}
